import { supabase, supabaseReady } from "./supabase";

const STORAGE_BUCKET = "metrocheck-files";
const SIGNED_URL_SECONDS = 24 * 60 * 60;

function requireSupabase() {
  if (!supabaseReady || !supabase) {
    throw new Error(
      "Supabase is not configured. Add VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY to .env."
    );
  }
}

function sanitizeFileName(name) {
  return (
    String(name || "file")
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 120) || "file"
  );
}

function serializableRecord(record) {
  return JSON.parse(
    JSON.stringify(record, function (key, value) {
      if (key === "file") {
        return undefined;
      }

      return value;
    })
  );
}

function mapProfile(row) {
  if (!row) {
    return null;
  }

  return {
    uid: row.user_id,
    id: row.inspector_id,
    name: row.name || "Inspector",
    email: String(row.email || "").toLowerCase(),
    department: row.department || "Legal Metrology Department",
    office: row.office || "",
    role: String(row.role || "INSPECTOR").toUpperCase(),
    verified: Boolean(row.verified),
    verifiedAt: row.verified_at
      ? Date.parse(row.verified_at) || Date.now()
      : Date.now(),
  };
}

function getStorageMetadata(record) {
  var source =
    record && typeof record === "object"
      ? record
      : {};

  var storage =
    source._storage &&
    typeof source._storage === "object"
      ? source._storage
      : {};

  var packageStorage =
    storage.package &&
    typeof storage.package === "object"
      ? storage.package
      : {};

  var packagePaths = {};

  Object.keys(packageStorage).forEach(function (key) {
    if (packageStorage[key]) {
      packagePaths[key] = String(packageStorage[key]);
    }
  });

  return {
    package: packagePaths,

    evidence: Array.isArray(source.evidence)
      ? source.evidence
          .map(function (item) {
            return item && item.storagePath
              ? String(item.storagePath)
              : "";
          })
          .filter(Boolean)
      : [],
  };
}

function collectStoragePaths(record) {
  var storage = getStorageMetadata(record);

  return Object.keys(storage.package || {})
    .map(function (key) {
      return storage.package[key];
    })
    .concat(storage.evidence)
    .filter(Boolean);
}

async function createSignedUrlMap(paths) {
  requireSupabase();

  var uniquePaths = Array.from(
    new Set((paths || []).filter(Boolean))
  );

  var result = new Map();

  if (!uniquePaths.length) {
    return result;
  }

  var response = await supabase.storage
    .from(STORAGE_BUCKET)
    .createSignedUrls(
      uniquePaths,
      SIGNED_URL_SECONDS
    );

  if (response.error) {
    throw response.error;
  }

  (response.data || []).forEach(function (
    item,
    index
  ) {
    var path =
      item && item.path
        ? item.path
        : uniquePaths[index];

    var signedUrl =
      item &&
      (item.signedUrl || item.signedURL)
        ? item.signedUrl || item.signedURL
        : "";

    if (path && signedUrl) {
      result.set(path, signedUrl);
    }
  });

  return result;
}

function materializeRecord(
  record,
  signedUrlMap
) {
  var source = serializableRecord(
    record || {}
  );

  var storage =
    getStorageMetadata(source);

  var packageImages = {};

  Object.keys(
    storage.package || {}
  ).forEach(function (key) {
    var path =
      storage.package[key];

    packageImages[key] =
      path
        ? signedUrlMap.get(path) || ""
        : "";
  });

  var evidence =
    Array.isArray(source.evidence)
      ? source.evidence.map(function (
          item
        ) {
          if (
            !item ||
            !item.storagePath
          ) {
            return item;
          }

          return Object.assign(
            {},
            item,
            {
              url:
                signedUrlMap.get(
                  String(
                    item.storagePath
                  )
                ) || "",
            }
          );
        })
      : [];

  var preview =
    packageImages.front ||
    packageImages.back ||
    Object.keys(packageImages)
      .map(function (key) {
        return packageImages[key];
      })
      .find(Boolean) ||
    "";

  return Object.assign(
    {},
    source,
    {
      imagePreview: preview,
      packageImages: packageImages,
      evidence: evidence,
    }
  );
}

async function ensureInspectorProfile(user) {
  if (!user) {
    throw new Error(
      "No authenticated Supabase user is available."
    );
  }

  var existing =
    await fetchInspectorProfile(
      user.id
    );

  if (
    existing &&
    existing.verified
  ) {
    return existing;
  }

  var inspectorId = String(
    user.user_metadata &&
      user.user_metadata
        .metrocheck_inspector_id
      ? user.user_metadata
          .metrocheck_inspector_id
      : ""
  )
    .trim()
    .toUpperCase();

  if (!inspectorId) {
    throw new Error(
      "The account does not contain a MetroCheck inspector ID."
    );
  }

  var displayName = String(
    user.user_metadata &&
      user.user_metadata
        .metrocheck_display_name
      ? user.user_metadata
          .metrocheck_display_name
      : ""
  ).trim();

  var office = String(
    user.user_metadata &&
      user.user_metadata
        .metrocheck_office
      ? user.user_metadata
          .metrocheck_office
      : ""
  ).trim();

  /*
   * V3 prototype registration:
   * - existing approved registry identities still work;
   * - a brand-new prototype Inspector ID/email can also create an INSPECTOR
   *   profile without requiring the ID to be hard-coded in the React bundle;
   * - SUPERVISOR / ADMIN roles can only come from an existing approved registry
   *   row and are never granted by self-registration.
   */
  var response = await supabase.rpc(
    "register_metrocheck_account",
    {
      p_inspector_id:
        inspectorId,

      p_display_name:
        displayName || null,

      p_office:
        office || null,
    }
  );

  if (response.error) {
    throw response.error;
  }

  var row =
    Array.isArray(response.data)
      ? response.data[0]
      : response.data;

  return mapProfile(row);
}

export function observeAuthSession(
  callback
) {
  if (
    !supabaseReady ||
    !supabase
  ) {
    return function () {};
  }

  var active = true;

  var subscriptionResponse =
    null;

  function emit(user) {
    if (
      !active ||
      typeof callback !==
        "function"
    ) {
      return;
    }

    try {
      callback(user || null);
    } catch (error) {
      /*
       * A consumer callback must not break the Supabase auth listener itself.
       * The React component logs/handles its own async work separately.
       */
      console.error(
        "MetroCheck auth-session callback failed:",
        error
      );
    }
  }

  try {
    supabase.auth
      .getSession()
      .then(function (response) {
        emit(
          response &&
            response.data &&
            response.data.session
            ? response.data
                .session.user
            : null
        );
      })
      .catch(function (error) {
        console.error(
          "MetroCheck Supabase getSession failed:",
          error
        );

        emit(null);
      });
  } catch (error) {
    console.error(
      "MetroCheck Supabase session restore failed:",
      error
    );

    emit(null);
  }

  try {
    subscriptionResponse =
      supabase.auth.onAuthStateChange(
        function (
          _event,
          session
        ) {
          emit(
            session
              ? session.user
              : null
          );
        }
      );
  } catch (error) {
    console.error(
      "MetroCheck Supabase auth listener failed:",
      error
    );

    emit(null);
  }

  return function () {
    active = false;

    if (
      subscriptionResponse &&
      subscriptionResponse.data &&
      subscriptionResponse.data
        .subscription &&
      typeof subscriptionResponse
        .data.subscription
        .unsubscribe === "function"
    ) {
      subscriptionResponse.data.subscription.unsubscribe();
    }
  };
}

async function fetchInspectorProfile(
  uid
) {
  requireSupabase();

  var response =
    await supabase
      .from("inspectors")
      .select(
        "user_id, inspector_id, name, email, department, office, role, verified, verified_at"
      )
      .eq(
        "user_id",
        uid
      )
      .maybeSingle();

  if (response.error) {
    throw response.error;
  }

  return mapProfile(
    response.data
  );
}

export async function getInspectorProfile(
  uid
) {
  requireSupabase();

  var profile =
    await fetchInspectorProfile(
      uid
    );

  if (profile) {
    return profile;
  }

  var userResponse =
    await supabase.auth.getUser();

  if (userResponse.error) {
    throw userResponse.error;
  }

  var user =
    userResponse.data
      ? userResponse.data.user
      : null;

  if (
    !user ||
    user.id !== uid
  ) {
    return null;
  }

  /*
   * A previous registration attempt may have created the Supabase Auth user
   * before its MetroCheck profile existed. Completing the profile here makes
   * those accounts recoverable simply by signing in with the same password.
   */
  return ensureInspectorProfile(
    user
  );
}

export async function registerInspectorWithSupabase(
  registration,
  password
) {
  requireSupabase();

  var cleanEmail =
    String(
      registration &&
        registration.email
        ? registration.email
        : ""
    )
      .trim()
      .toLowerCase();

  var cleanInspectorId =
    String(
      registration &&
        registration.id
        ? registration.id
        : ""
    )
      .trim()
      .toUpperCase();

  var cleanDisplayName =
    String(
      registration &&
        registration.name
        ? registration.name
        : ""
    ).trim();

  var cleanOffice =
    String(
      registration &&
        registration.office
        ? registration.office
        : ""
    ).trim();

  if (
    !cleanEmail ||
    !cleanInspectorId
  ) {
    throw new Error(
      "Inspector ID and email are required."
    );
  }

  if (
    String(
      password || ""
    ).length < 6
  ) {
    throw new Error(
      "Password must contain at least 6 characters."
    );
  }

  /*
   * Check conflicts BEFORE Auth sign-up.
   * This avoids creating an orphan Auth user
   * when an Inspector ID is already linked
   * to somebody else.
   */
  var availability =
    await supabase.rpc(
      "metrocheck_registration_status",
      {
        p_inspector_id:
          cleanInspectorId,

        p_email:
          cleanEmail,
      }
    );

  if (availability.error) {
    var availabilityMessage =
      String(
        availability.error &&
          availability.error.message
          ? availability.error.message
          : ""
      );

    if (
      availabilityMessage
        .toLowerCase()
        .includes("function") &&
      availabilityMessage
        .toLowerCase()
        .includes(
          "metrocheck_registration_status"
        )
    ) {
      throw new Error(
        "MetroCheck registration database update is missing. Run MetroCheck_Registration_Consumer_Fix.sql once in Supabase SQL Editor."
      );
    }

    throw availability.error;
  }

  var registrationStatus =
    String(
      availability.data || ""
    ).toUpperCase();

  if (
    registrationStatus ===
    "EMAIL_ACCOUNT_EXISTS"
  ) {
    throw new Error(
      "This email already has a MetroCheck account. Please use Sign in."
    );
  }

  if (
    registrationStatus ===
    "INSPECTOR_ID_TAKEN"
  ) {
    throw new Error(
      "This MetroCheck Inspector ID is already linked to another account."
    );
  }

  if (
    registrationStatus ===
    "EMAIL_REGISTRY_TAKEN"
  ) {
    throw new Error(
      "This email is already linked to a different MetroCheck Inspector ID."
    );
  }

  if (
    registrationStatus ===
    "INACTIVE"
  ) {
    throw new Error(
      "This MetroCheck Inspector ID is inactive. Contact a supervisor or administrator."
    );
  }

  if (
    registrationStatus !==
    "AVAILABLE"
  ) {
    throw new Error(
      "MetroCheck could not validate this registration request."
    );
  }

  var response =
    await supabase.auth.signUp({
      email: cleanEmail,

      password:
        String(
          password || ""
        ),

      options: {
        data: {
          metrocheck_inspector_id:
            cleanInspectorId,

          metrocheck_display_name:
            cleanDisplayName,

          metrocheck_office:
            cleanOffice,
        },
      },
    });

  if (response.error) {
    throw response.error;
  }

  var user =
    response.data
      ? response.data.user
      : null;

  var session =
    response.data
      ? response.data.session
      : null;

  if (!user) {
    throw new Error(
      "Supabase did not return a new user account."
    );
  }

  if (!session) {
    return {
      user: user,
      profile: null,
      confirmationRequired: true,
    };
  }

  try {
    var profile =
      await ensureInspectorProfile(
        user
      );

    return {
      user: user,
      profile: profile,
      confirmationRequired: false,
    };
  } catch (error) {
    /*
     * Frontend clients cannot delete an Auth user.
     * Keep the account recoverable:
     * the next successful sign-in will retry
     * ensureInspectorProfile().
     */
    await supabase.auth
      .signOut()
      .catch(function () {});

    throw error;
  }
}

export async function loginInspectorWithSupabase(
  email,
  password
) {
  requireSupabase();

  var response =
    await supabase.auth.signInWithPassword({
      email: String(
        email || ""
      )
        .trim()
        .toLowerCase(),

      password: String(
        password || ""
      ),
    });

  if (response.error) {
    throw response.error;
  }

  var user =
    response.data
      ? response.data.user
      : null;

  try {
    var profile =
      await ensureInspectorProfile(
        user
      );

    if (
      !profile ||
      !profile.verified
    ) {
      throw new Error(
        "This account does not have a verified MetroCheck inspector profile."
      );
    }

    return {
      user: user,
      profile: profile,
    };
  } catch (error) {
    await supabase.auth
      .signOut()
      .catch(function () {});

    throw error;
  }
}

export async function logoutInspectorFromSupabase() {
  if (
    supabaseReady &&
    supabase
  ) {
    var response =
      await supabase.auth.signOut();

    if (response.error) {
      throw response.error;
    }
  }
}

export async function updateInspectorProfile(
  uid,
  changes
) {
  requireSupabase();

  var allowed = {};

  if (
    Object.prototype.hasOwnProperty.call(
      changes || {},
      "name"
    )
  ) {
    allowed.name =
      String(
        changes.name || ""
      ).trim();
  }

  if (
    Object.prototype.hasOwnProperty.call(
      changes || {},
      "department"
    )
  ) {
    allowed.department =
      String(
        changes.department ||
          ""
      ).trim();
  }

  if (
    Object.prototype.hasOwnProperty.call(
      changes || {},
      "office"
    )
  ) {
    allowed.office =
      String(
        changes.office || ""
      ).trim();
  }

  if (
    !Object.keys(
      allowed
    ).length
  ) {
    return;
  }

  allowed.updated_at =
    new Date().toISOString();

  var response =
    await supabase
      .from("inspectors")
      .update(
        allowed
      )
      .eq(
        "user_id",
        uid
      );

  if (response.error) {
    throw response.error;
  }
}

async function uploadPackageImage(
  uid,
  inspectionId,
  side,
  item,
  previousPath
) {
  if (
    !item ||
    !item.file
  ) {
    return previousPath || "";
  }

  var mimeType =
    String(
      item.file.type ||
        "image/jpeg"
    ).toLowerCase();

  var extension =
    mimeType === "image/png"
      ? "png"
      : mimeType === "image/webp"
      ? "webp"
      : "jpg";

  var path =
    uid +
    "/" +
    inspectionId +
    "/package/" +
    side +
    "." +
    extension;

  var response =
    await supabase.storage
      .from(
        STORAGE_BUCKET
      )
      .upload(
        path,
        item.file,
        {
          contentType:
            mimeType,

          cacheControl:
            "3600",

          upsert: true,
        }
      );

  if (response.error) {
    throw response.error;
  }

  return path;
}

async function uploadEvidenceFiles(
  uid,
  inspectionId,
  evidence
) {
  var result = [];

  for (
    var index = 0;
    index <
    (evidence || [])
      .length;
    index += 1
  ) {
    var item =
      evidence[index];

    if (!item) {
      continue;
    }

    if (!item.file) {
      result.push(
        serializableRecord(
          item
        )
      );

      continue;
    }

    var safeName =
      sanitizeFileName(
        item.name ||
          item.file.name
      );

    var objectPath =
      uid +
      "/" +
      inspectionId +
      "/evidence/" +
      sanitizeFileName(
        item.id
      ) +
      "-" +
      safeName;

    var response =
      await supabase.storage
        .from(
          STORAGE_BUCKET
        )
        .upload(
          objectPath,
          item.file,
          {
            contentType:
              item.file.type ||
              item.type ||
              "application/octet-stream",

            cacheControl:
              "3600",

            upsert: true,
          }
        );

    if (response.error) {
      throw response.error;
    }

    result.push({
      id: item.id,

      name:
        item.name ||
        item.file.name,

      size:
        item.size ||
        item.file.size ||
        0,

      type:
        item.type ||
        item.file.type ||
        "",

      addedAt:
        item.addedAt ||
        Date.now(),

      storagePath:
        objectPath,
    });
  }

  return result;
}

export async function saveCloudInspection(
  record,
  packageImages,
  evidence,
  uid
) {
  requireSupabase();

  var inspectionId =
    String(
      record.id
    );

  var previousResponse =
    await supabase
      .from(
        "inspections"
      )
      .select(
        "record"
      )
      .eq(
        "id",
        inspectionId
      )
      .maybeSingle();

  if (
    previousResponse.error
  ) {
    throw previousResponse.error;
  }

  var previousRecord =
    previousResponse.data
      ? previousResponse
          .data.record
      : null;

  var previousStorage =
    getStorageMetadata(
      previousRecord
    );

  var panelKeys =
    Array.from(
      new Set(
        Object.keys(
          packageImages ||
            {}
        ).concat(
          Object.keys(
            previousStorage.package ||
              {}
          )
        )
      )
    );

  var panelUploads =
    await Promise.all(
      panelKeys.map(
        function (side) {
          return uploadPackageImage(
            uid,
            inspectionId,
            side,
            packageImages &&
              packageImages[
                side
              ],
            previousStorage.package &&
              previousStorage.package[
                side
              ]
          );
        }
      )
    );

  var packagePaths = {};

  panelKeys.forEach(
    function (
      side,
      index
    ) {
      if (
        panelUploads[
          index
        ]
      ) {
        packagePaths[
          side
        ] =
          panelUploads[
            index
          ];
      }
    }
  );

  var uploadedEvidence =
    await uploadEvidenceFiles(
      uid,
      inspectionId,
      evidence
    );

  var stableRecord =
    serializableRecord(
      Object.assign(
        {},
        record,
        {
          ownerUid: uid,

          ownerId:
            record.ownerId ||
            "",

          imagePreview:
            "",

          packageImages:
            Object.keys(
              packagePaths
            ).reduce(
              function (
                result,
                key
              ) {
                result[
                  key
                ] = "";

                return result;
              },
              {}
            ),

          evidence:
            uploadedEvidence.map(
              function (
                item
              ) {
                var copy =
                  Object.assign(
                    {},
                    item
                  );

                delete copy.url;

                return copy;
              }
            ),

          _storage: {
            provider:
              "supabase",

            bucket:
              STORAGE_BUCKET,

            package:
              packagePaths,
          },

          cloudUpdatedAt:
            Date.now(),
        }
      )
    );

  var saveResponse =
    await supabase
      .from(
        "inspections"
      )
      .upsert(
        {
          id:
            inspectionId,

          owner_uid:
            uid,

          owner_id:
            String(
              record.ownerId ||
                ""
            ),

          timestamp:
            Number(
              record.timestamp ||
                Date.now()
            ),

          record:
            stableRecord,

          updated_at:
            new Date().toISOString(),
        },

        {
          onConflict:
            "id",
        }
      );

  if (
    saveResponse.error
  ) {
    throw saveResponse.error;
  }

  var currentPaths =
    new Set(
      collectStoragePaths(
        stableRecord
      )
    );

  var orphanedPaths =
    collectStoragePaths(
      previousRecord
    ).filter(
      function (path) {
        return !currentPaths.has(
          path
        );
      }
    );

  if (
    orphanedPaths.length
  ) {
    var cleanupResponse =
      await supabase.storage
        .from(
          STORAGE_BUCKET
        )
        .remove(
          orphanedPaths
        );

    if (
      cleanupResponse.error
    ) {
      console.warn(
        "MetroCheck Supabase storage cleanup skipped:",
        cleanupResponse.error
      );
    }
  }

  var signedUrlMap =
    await createSignedUrlMap(
      collectStoragePaths(
        stableRecord
      )
    );

  return materializeRecord(
    stableRecord,
    signedUrlMap
  );
}

export async function loadCloudHistory(
  uid
) {
  requireSupabase();

  var response =
    await supabase
      .from(
        "inspections"
      )
      .select(
        "id, record, timestamp"
      )
      .eq(
        "owner_uid",
        uid
      )
      .order(
        "timestamp",
        {
          ascending:
            false,
        }
      );

  if (response.error) {
    throw response.error;
  }

  var rows =
    response.data || [];

  var paths = [];

  rows.forEach(
    function (row) {
      paths =
        paths.concat(
          collectStoragePaths(
            row.record
          )
        );
    }
  );

  var signedUrlMap =
    await createSignedUrlMap(
      paths
    );

  return rows.map(
    function (row) {
      return materializeRecord(
        Object.assign(
          {},
          row.record || {},
          {
            id: row.id,
          }
        ),

        signedUrlMap
      );
    }
  );
}

export async function loadSupervisorHistory(
  uid
) {
  requireSupabase();

  var profile =
    await fetchInspectorProfile(
      uid
    );

  if (
    !profile ||
    (
      profile.role !==
        "SUPERVISOR" &&
      profile.role !==
        "ADMIN"
    )
  ) {
    throw new Error(
      "Supervisor access is required."
    );
  }

  var response =
    await supabase
      .from(
        "inspections"
      )
      .select(
        "id, record, timestamp"
      )
      .order(
        "timestamp",
        {
          ascending:
            false,
        }
      );

  if (response.error) {
    throw response.error;
  }

  var rows =
    response.data || [];

  /*
   * Supervisor overview is metadata-first.
   * Private package/evidence files remain
   * owner-scoped under the existing Storage
   * RLS policy.
   */
  var emptySignedUrlMap =
    new Map();

  return rows.map(
    function (row) {
      return materializeRecord(
        Object.assign(
          {},
          row.record || {},
          {
            id: row.id,
          }
        ),

        emptySignedUrlMap
      );
    }
  );
}

export async function deleteCloudInspection(
  inspectionId,
  uid
) {
  requireSupabase();

  var lookupResponse =
    await supabase
      .from(
        "inspections"
      )
      .select(
        "record"
      )
      .eq(
        "id",
        String(
          inspectionId
        )
      )
      .eq(
        "owner_uid",
        uid
      )
      .maybeSingle();

  if (
    lookupResponse.error
  ) {
    throw lookupResponse.error;
  }

  var storagePaths =
    collectStoragePaths(
      lookupResponse.data
        ? lookupResponse.data
            .record
        : null
    );

  if (
    storagePaths.length
  ) {
    var storageResponse =
      await supabase.storage
        .from(
          STORAGE_BUCKET
        )
        .remove(
          storagePaths
        );

    if (
      storageResponse.error
    ) {
      console.warn(
        "MetroCheck Supabase storage cleanup skipped:",
        storageResponse.error
      );
    }
  }

  var deleteResponse =
    await supabase
      .from(
        "inspections"
      )
      .delete()
      .eq(
        "id",
        String(
          inspectionId
        )
      )
      .eq(
        "owner_uid",
        uid
      );

  if (
    deleteResponse.error
  ) {
    throw deleteResponse.error;
  }
}

export async function clearCloudHistory(
  uid
) {
  requireSupabase();

  var response =
    await supabase
      .from(
        "inspections"
      )
      .select(
        "id, record"
      )
      .eq(
        "owner_uid",
        uid
      );

  if (response.error) {
    throw response.error;
  }

  var rows =
    response.data || [];

  var paths = [];

  rows.forEach(
    function (row) {
      paths =
        paths.concat(
          collectStoragePaths(
            row.record
          )
        );
    }
  );

  if (
    paths.length
  ) {
    var storageResponse =
      await supabase.storage
        .from(
          STORAGE_BUCKET
        )
        .remove(
          Array.from(
            new Set(
              paths
            )
          )
        );

    if (
      storageResponse.error
    ) {
      console.warn(
        "MetroCheck Supabase storage cleanup skipped:",
        storageResponse.error
      );
    }
  }

  var deleteResponse =
    await supabase
      .from(
        "inspections"
      )
      .delete()
      .eq(
        "owner_uid",
        uid
      );

  if (
    deleteResponse.error
  ) {
    throw deleteResponse.error;
  }
}