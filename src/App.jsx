import { Component, useEffect, useMemo, useRef, useState } from "react";
import { createWorker } from "tesseract.js";
import { jsPDF } from "jspdf";
import { supabaseConfigError, supabaseReady } from "./supabase";
import {
  clearCloudHistory,
  deleteCloudInspection,
  getInspectorProfile,
  loadCloudHistory,
  loginInspectorWithSupabase,
  logoutInspectorFromSupabase,
  observeAuthSession,
  registerInspectorWithSupabase,
  saveCloudInspection,
  updateInspectorProfile,
} from "./supabaseServices";
import "./App.css";

const HISTORY_KEY = "metrocheck_inspections_v8";
const INSPECTOR_ACCOUNTS_KEY = "metrocheck_inspector_accounts_v1";
const CURRENT_INSPECTOR_KEY = "metrocheck_current_inspector_v1";
const AUTH_SESSION_KEY = "metrocheck_auth_session_v1";

/*
 * Mock government registry for the SIH prototype. In production this would
 * be replaced by a secure department/Legal Metrology backend.
 */
const GOVERNMENT_INSPECTOR_REGISTRY = [
  {
    id: "INS-001",
    name: "Inspector",
    email: "inspector@demo.metrology.gov.in",
    department: "Legal Metrology Department",
    office: "West Godavari",
  },
  {
    id: "INS-002",
    name: "Priya Sharma",
    email: "priya.sharma@demo.metrology.gov.in",
    department: "Legal Metrology Department",
    office: "Krishna",
  },
  {
    id: "INS-003",
    name: "Ravi Kumar",
    email: "ravi.kumar@demo.metrology.gov.in",
    department: "Legal Metrology Department",
    office: "East Godavari",
  },
];

const EMPTY_FIELDS = {
  manufacturer: "",
  importer: "",
  countryOfOrigin: "",
  productName: "",
  netQuantity: "",
  manufactureDate: "",
  bestBefore: "",
  mrp: "",
  consumerCare: "",
  dimensions: "",
  unitSalePrice: "",
};

const EMPTY_INSPECTOR = {
  name: "",
  id: "",
};

const DEFAULT_INSPECTOR = {
  name: "Inspector",
  id: "INS-001",
};

const FIELD_CONFIG = [
  ["manufacturer", "Manufacturer / Packer", "e.g. ABC Foods Pvt. Ltd."],
  ["importer", "Importer", "e.g. ABC Imports Pvt. Ltd."],
  ["countryOfOrigin", "Country of Origin", "e.g. India"],
  ["productName", "Common / Generic Name", "e.g. Basmati Rice"],
  ["netQuantity", "Net Quantity", "e.g. 1 kg"],
  ["manufactureDate", "Manufacture / Packing Date", "e.g. 08/2026"],
  ["bestBefore", "Best Before / Use By", "e.g. 12 Months"],
  ["mrp", "Maximum Retail Price", "e.g. ₹120"],
  ["consumerCare", "Consumer Care", "e.g. 1800-123-4567"],
  ["dimensions", "Dimensions", "e.g. 20 cm x 12 cm"],
  ["unitSalePrice", "Unit Sale Price", "e.g. ₹120/kg"],
];

const RULES = [
  {
    id: "manufacturer",
    title: "Manufacturer / Packer / Importer",
    short: "Responsible entity declaration",
    severity: "High",
    reference: "Rule 6(1)(a)",
    description:
      "The applicable responsible entity and required address information should be declared. OCR presence is treated as a screening result; the inspector must visually verify the complete declaration.",
    evaluate: function (fields) {
      if (fields.manufacturer || fields.importer) {
        return {
          status: "PASS",
          message:
            "A responsible manufacturer, packer or importer declaration was identified. Verify the complete name and address on the package before finalizing.",
        };
      }
      return {
        status: "REVIEW REQUIRED",
        message:
          "A responsible entity declaration could not be identified by OCR. Inspect the package manually before deciding compliance.",
      };
    },
  },
  {
    id: "origin",
    title: "Country of Origin",
    short: "Imported-product origin declaration",
    severity: "High",
    reference: "Rule 6(1)(aa)",
    description:
      "Country-of-origin declaration is specifically applicable to imported products. It is not treated as a universal failure for domestically made goods.",
    evaluate: function (fields) {
      if (!fields.importer) {
        return {
          status: "NOT APPLICABLE",
          message:
            "No importer declaration was identified. Country-of-origin checking is not automatically applicable to a domestic package; inspector verification is still required if import status is uncertain.",
        };
      }

      if (fields.countryOfOrigin) {
        return {
          status: "PASS",
          message:
            "A country-of-origin declaration was identified for the package marked as imported.",
        };
      }

      return {
        status: "REVIEW REQUIRED",
        message:
          "An importer declaration was identified, but country of origin was not identified by OCR. Inspect the package and verify the imported-product declaration.",
      };
    },
  },
  {
    id: "generic",
    title: "Common / Generic Name",
    short: "Commodity identification",
    severity: "Medium",
    reference: "Rule 6(1)(b)",
    description:
      "The common or generic name of the commodity should be identifiable on the package.",
    evaluate: function (fields) {
      return fields.productName
        ? {
            status: "PASS",
            message:
              "A common or generic commodity name was identified in the scanned declarations.",
          }
        : {
            status: "REVIEW REQUIRED",
            message:
              "A common or generic name could not be identified by OCR. Verify the principal display panel manually.",
          };
    },
  },
  {
    id: "quantity",
    title: "Net Quantity",
    short: "Quantity declaration",
    severity: "Critical",
    reference: "Rule 6(1)(c), Rules 11–13",
    description:
      "The package should declare net quantity in the appropriate unit. Actual quantity verification is separate and must use the applicable legal measurement framework.",
    evaluate: function (fields) {
      return fields.netQuantity
        ? {
            status: "PASS",
            message:
              "A net-quantity declaration was identified. Physical quantity verification remains a separate inspector check.",
          }
        : {
            status: "REVIEW REQUIRED",
            message:
              "A net-quantity declaration could not be identified by OCR. Verify the package manually before making a decision.",
          };
    },
  },
  {
    id: "date",
    title: "Date of Manufacture / Packing / Import",
    short: "Date declaration",
    severity: "Medium",
    reference: "Rule 6(1)(d)",
    description:
      "Applicable manufacture, packing or import-date requirements depend on the commodity and other applicable legislation, including specified exceptions.",
    evaluate: function (fields) {
      return fields.manufactureDate
        ? {
            status: "PASS",
            message:
              "A manufacture, packing or related date declaration was identified. Confirm that the date format and applicable commodity requirement are correct.",
          }
        : {
            status: "REVIEW REQUIRED",
            message:
              "No applicable date declaration was identified by OCR. Because the Rules contain commodity-specific exceptions, an inspector must verify whether this declaration is required.",
          };
    },
  },
  {
    id: "bestBefore",
    title: "Best Before / Use By",
    short: "Validity declaration where applicable",
    severity: "High",
    reference: "Rule 6(1)(da)",
    description:
      "Best-before/use-by information applies where the commodity may become unfit for human consumption, subject to applicable food or other legislation.",
    evaluate: function (fields) {
      if (fields.bestBefore) {
        return {
          status: "PASS",
          message:
            "A best-before/use-by declaration was identified. Verify that the applicable food or commodity rule is satisfied.",
        };
      }

      return {
        status: "REVIEW REQUIRED",
        message:
          "No best-before/use-by declaration was identified. Applicability must be confirmed for the specific commodity rather than treating every package as universally subject to this check.",
      };
    },
  },
  {
    id: "mrp",
    title: "Maximum Retail Price",
    short: "Retail sale price declaration",
    severity: "Critical",
    reference: "Rule 6(1)(e)",
    description:
      "The retail sale price should be declared as the maximum retail price inclusive of applicable taxes and in the prescribed manner.",
    evaluate: function (fields) {
      return fields.mrp
        ? {
            status: "PASS",
            message:
              "An MRP declaration was identified. The inspector should visually verify that it is legible, properly expressed and not altered.",
          }
        : {
            status: "REVIEW REQUIRED",
            message:
              "An MRP declaration could not be identified by OCR. Verify the package manually before making a decision.",
          };
    },
  },
  {
    id: "consumer",
    title: "Consumer Care Details",
    short: "Consumer complaint contact",
    severity: "Medium",
    reference: "Rule 6(2)",
    description:
      "The prescribed name/address and contact details for consumer complaints should be available. OCR presence alone does not prove completeness.",
    evaluate: function (fields) {
      return fields.consumerCare
        ? {
            status: "PASS",
            message:
              "Consumer-care/contact information was identified. Verify the complete prescribed contact details visually.",
          }
        : {
            status: "REVIEW REQUIRED",
            message:
              "Consumer-care/contact information could not be identified by OCR. Inspect the package manually.",
          };
    },
  },
  {
    id: "dimensions",
    title: "Dimensions",
    short: "Dimension declaration where relevant",
    severity: "Low",
    reference: "Rule 6(1)(f)",
    description:
      "Dimensions are not a universal package declaration; this check is only relevant to commodities for which dimensions are applicable.",
    evaluate: function (fields) {
      if (fields.dimensions) {
        return {
          status: "PASS",
          message:
            "A dimension declaration was identified. Confirm that dimensions are relevant to this commodity and that the declaration is correct.",
        };
      }

      return {
        status: "NOT APPLICABLE",
        message:
          "No dimension declaration was identified. Dimensions are not treated as a universal requirement; verify applicability for the commodity if relevant.",
      };
    },
  },
  {
    id: "unitPrice",
    title: "Unit Sale Price",
    short: "Unit price where applicable",
    severity: "Medium",
    reference: "Rule 6(11)",
    description:
      "Unit sale price follows the prescribed unit and rounding rules, with stated exceptions such as where the retail sale price equals the unit sale price.",
    evaluate: function (fields) {
      if (fields.unitSalePrice) {
        return {
          status: "PASS",
          message:
            "A unit-sale-price declaration was identified. Verify the prescribed unit, rounding and any applicable exception.",
        };
      }

      return {
        status: "REVIEW REQUIRED",
        message:
          "A unit-sale-price declaration was not identified by OCR. Verify applicability and the Rule 6(11) exceptions before deciding compliance.",
      };
    },
  },
];

function normalizeText(value) {
  return String(value || "")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function formatDate(date) {
  var value = date || new Date();

  return value.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function formatTime(date) {
  var value = date || new Date();

  return value.toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function normalizeInspectorAccount(account) {
  var source = account && typeof account === "object"
    ? account
    : {};

  var id = String(source.id || "").trim();
  var name = String(source.name || "").trim();

  return {
    id: id || DEFAULT_INSPECTOR.id,
    name: name || DEFAULT_INSPECTOR.name,
    email: String(source.email || "").trim().toLowerCase(),
    password: String(source.password || ""),
    verified: Boolean(source.verified),
    department: String(source.department || "Legal Metrology Department"),
    office: String(source.office || ""),
  };
}

function loadInspectorAccounts() {
  try {
    var saved = JSON.parse(
      localStorage.getItem(INSPECTOR_ACCOUNTS_KEY) || "[]"
    );

    if (Array.isArray(saved) && saved.length) {
      return saved.map(normalizeInspectorAccount);
    }
  } catch (error) {
    console.error(error);
  }

  return [Object.assign({}, DEFAULT_INSPECTOR)];
}

function saveInspectorAccounts(accounts) {
  try {
    localStorage.setItem(
      INSPECTOR_ACCOUNTS_KEY,
      JSON.stringify(accounts)
    );
    return true;
  } catch (error) {
    console.error(error);
    return false;
  }
}

function getCurrentInspectorId(accounts) {
  try {
    var savedId = String(
      localStorage.getItem(CURRENT_INSPECTOR_KEY) || ""
    ).trim();

    if (savedId && accounts.some(function (account) {
      return account.id === savedId;
    })) {
      return savedId;
    }
  } catch (error) {
    console.error(error);
  }

  return accounts[0] ? accounts[0].id : DEFAULT_INSPECTOR.id;
}

function saveCurrentInspectorId(id) {
  try {
    localStorage.setItem(
      CURRENT_INSPECTOR_KEY,
      String(id || DEFAULT_INSPECTOR.id)
    );
  } catch (error) {
    console.error(error);
  }
}

function getAuthSessionId() {
  try {
    return String(
      localStorage.getItem(AUTH_SESSION_KEY) || ""
    ).trim();
  } catch (error) {
    console.error(error);
    return "";
  }
}

function saveAuthSessionId(id) {
  try {
    if (id) {
      localStorage.setItem(AUTH_SESSION_KEY, String(id));
    } else {
      localStorage.removeItem(AUTH_SESSION_KEY);
    }
  } catch (error) {
    console.error(error);
  }
}

function getAllStoredHistory() {
  try {
    var saved = JSON.parse(
      localStorage.getItem(HISTORY_KEY) || "[]"
    );

    if (Array.isArray(saved)) {
      return saved.map(function (item) {
        return normalizeHistoryRecord(item);
      });
    }
  } catch (error) {
    console.error(error);
  }

  return [];
}

function saveAllStoredHistory(records) {
  try {
    localStorage.setItem(
      HISTORY_KEY,
      JSON.stringify(records)
    );
    return true;
  } catch (error) {
    console.error(error);
    return false;
  }
}

function getHistoryOwnerId(record) {
  if (record && record.ownerId) {
    return String(record.ownerId);
  }

  if (record && record.inspector && record.inspector.id) {
    return String(record.inspector.id);
  }

  return DEFAULT_INSPECTOR.id;
}

function getRecordTimestamp(record) {
  var raw = Number(record && record.timestamp);

  if (Number.isFinite(raw) && raw > 0) {
    return raw;
  }

  if (record && record.date) {
    var parsed = Date.parse(
      String(record.date) +
        (record.time ? " " + String(record.time) : "")
    );

    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return 0;
}

function normalizeHistoryRecord(record) {
  var source = record && typeof record === "object"
    ? record
    : {};

  var timestamp = getRecordTimestamp(source);
  var dateValue = timestamp
    ? new Date(timestamp)
    : null;

  return Object.assign(
    {},
    source,
    {
      id: source.id || makeInspectionId(),
      ownerId: getHistoryOwnerId(source),
      productName:
        source.productName ||
        (source.fields && source.fields.productName) ||
        "Unknown commodity",
      status:
        source.status ||
        source.decision ||
        "REVIEW REQUIRED",
      score: Number.isFinite(Number(source.score))
        ? Number(source.score)
        : 0,
      ruleResults: Array.isArray(source.ruleResults)
        ? source.ruleResults
        : [],
      evidence: Array.isArray(source.evidence)
        ? source.evidence
        : [],
      inspector:
        source.inspector && typeof source.inspector === "object"
          ? source.inspector
          : Object.assign({}, EMPTY_INSPECTOR),
      fields:
        source.fields && typeof source.fields === "object"
          ? Object.assign({}, EMPTY_FIELDS, source.fields)
          : Object.assign({}, EMPTY_FIELDS),
      timestamp: timestamp || Date.now(),
      date:
        dateValue
          ? formatDate(dateValue)
          : source.date || formatDate(),
      time:
        dateValue
          ? formatTime(dateValue)
          : source.time || formatTime(),
    }
  );
}

function makeInspectionId() {
  var d = new Date();

  var stamp =
    String(d.getFullYear()).slice(-2) +
    String(d.getMonth() + 1).padStart(2, "0") +
    String(d.getDate()).padStart(2, "0");

  var random = Math.floor(1000 + Math.random() * 9000);

  return "MC-" + stamp + "-" + random;
}

function findMatch(text, patterns) {
  for (var i = 0; i < patterns.length; i += 1) {
    var match = text.match(patterns[i]);

    if (match && match[1]) {
      return match[1].trim();
    }
  }

  return "";
}

function cleanExtractedValue(value) {
  if (!value) {
    return "";
  }

  return value
    .replace(/\s+/g, " ")
    .replace(/^[\s:;,\-]+/, "")
    .trim();
}

function extractFields(rawText) {
  var text = normalizeText(rawText);
  var lower = text.toLowerCase();

  var fields = {
    manufacturer: cleanExtractedValue(
      findMatch(text, [
        /(?:manufactured by|manufacturer|manufactured\/packed by|packed by)\s*[:\-]?\s*([^\n]+)/i,
        /(?:mfg\.?|mfd\.?)\s*(?:by)?\s*[:\-]?\s*([^\n]+)/i,
      ])
    ),

    importer: cleanExtractedValue(
      findMatch(text, [
        /(?:imported by|importer)\s*[:\-]?\s*([^\n]+)/i,
      ])
    ),

    countryOfOrigin: cleanExtractedValue(
      findMatch(text, [
        /(?:country of origin|origin)\s*[:\-]?\s*([^\n]+)/i,
        /(?:made in)\s*[:\-]?\s*([^\n]+)/i,
      ])
    ),

    productName: cleanExtractedValue(
      findMatch(text, [
        /(?:product name|common name|generic name)\s*[:\-]?\s*([^\n]+)/i,
      ])
    ),

    netQuantity: cleanExtractedValue(
      findMatch(text, [
        /(?:net quantity|net qty|net weight|net wt\.?)\s*[:\-]?\s*([^\n]+)/i,
      ])
    ),

    manufactureDate: cleanExtractedValue(
      findMatch(text, [
        /(?:date of manufacture|date of mfg|mfg\.?\s*date|packed on|packing date|date of packing|mfd)\s*[:\-]?\s*([^\n]+)/i,
      ])
    ),

    bestBefore: cleanExtractedValue(
      findMatch(text, [
        /(?:best before|use by|expiry|expires|exp)\s*[:\-]?\s*([^\n]+)/i,
      ])
    ),

    mrp: cleanExtractedValue(
      findMatch(text, [
        /(?:mrp|maximum retail price)\s*[:\-]?\s*((?:₹|rs\.?|inr)?\s*[\d,]+(?:\.\d{1,2})?)/i,
      ])
    ),

    consumerCare: cleanExtractedValue(
      findMatch(text, [
        /(?:consumer care|customer care|helpline|toll free|contact us)\s*[:\-]?\s*([^\n]+)/i,
      ])
    ),

    dimensions: cleanExtractedValue(
      findMatch(text, [
        /(?:dimensions|dimension|size)\s*[:\-]?\s*([^\n]+)/i,
      ])
    ),

    unitSalePrice: cleanExtractedValue(
      findMatch(text, [
        /(?:unit sale price|unit price|price per)\s*[:\-]?\s*([^\n]+)/i,
      ])
    ),
  };

  if (!fields.netQuantity) {
    var quantityMatch = text.match(
      /\b\d+(?:\.\d+)?\s?(?:kg|g|mg|ml|l|litre|liter)\b/i
    );

    if (quantityMatch) {
      fields.netQuantity = quantityMatch[0];
    }
  }

  if (!fields.mrp) {
    var mrpMatch = text.match(
      /(?:₹|rs\.?|inr)\s?[\d,]+(?:\.\d{1,2})?/i
    );

    if (mrpMatch) {
      fields.mrp = mrpMatch[0];
    }
  }

  if (!fields.countryOfOrigin && lower.includes("made in india")) {
    fields.countryOfOrigin = "India";
  }

  if (!fields.productName) {
    var lines = text
      .split("\n")
      .map(function (line) {
        return line.trim();
      })
      .filter(function (line) {
        return line.length > 3;
      });

    var possibleProduct = lines.find(function (line) {
      return !/mrp|manufact|packed|import|country|quantity|best before|expiry|consumer|fssai|batch|date|licence|license/i.test(
        line
      );
    });

    if (possibleProduct) {
      fields.productName = possibleProduct;
    }
  }

  return fields;
}

/*
 * Basic mass / volume normalization for demonstration screening.
 * This is NOT a statutory Legal Metrology tolerance calculation.
 */
function parseQuantity(value) {
  var text = String(value || "")
    .toLowerCase()
    .replace(/,/g, "")
    .trim();

  var match = text.match(
    /(\d+(?:\.\d+)?)\s*(kg|g|mg|ml|l|litre|liter)\b/i
  );

  if (!match) {
    return null;
  }

  var number = Number(match[1]);
  var unit = match[2].toLowerCase();

  if (!Number.isFinite(number) || number <= 0) {
    return null;
  }

  if (unit === "kg") {
    return {
      value: number * 1000,
      unit: "g",
      originalValue: number,
      originalUnit: "kg",
    };
  }

  if (unit === "mg") {
    return {
      value: number / 1000,
      unit: "g",
      originalValue: number,
      originalUnit: "mg",
    };
  }

  if (unit === "g") {
    return {
      value: number,
      unit: "g",
      originalValue: number,
      originalUnit: "g",
    };
  }

  if (
    unit === "l" ||
    unit === "litre" ||
    unit === "liter"
  ) {
    return {
      value: number * 1000,
      unit: "ml",
      originalValue: number,
      originalUnit: unit,
    };
  }

  return {
    value: number,
    unit: "ml",
    originalValue: number,
    originalUnit: "ml",
  };
}

function buildQuantityVerification(
  fields,
  physicalQuantity,
  physicalUnit
) {
  var declared = parseQuantity(fields.netQuantity);
  var measuredNumber = Number(physicalQuantity);

  if (
    !declared ||
    !Number.isFinite(measuredNumber) ||
    measuredNumber <= 0
  ) {
    return {
      available: false,
      comparable: false,
      status: "NOT VERIFIED",
      declared: null,
      measured: null,
      difference: null,
      differencePercent: null,
      message:
        "Enter a valid measured quantity and ensure the declared quantity can be interpreted with a supported unit.",
    };
  }

  var normalizedMeasured = measuredNumber;
  var normalizedUnit = String(physicalUnit || "").toLowerCase();

  if (
    declared.unit === "g" &&
    normalizedUnit === "kg"
  ) {
    normalizedMeasured = measuredNumber * 1000;
  } else if (
    declared.unit === "g" &&
    normalizedUnit === "mg"
  ) {
    normalizedMeasured = measuredNumber / 1000;
  } else if (
    declared.unit === "ml" &&
    normalizedUnit === "l"
  ) {
    normalizedMeasured = measuredNumber * 1000;
  }

  var compatible =
    (declared.unit === "g" &&
      (normalizedUnit === "g" ||
        normalizedUnit === "kg" ||
        normalizedUnit === "mg")) ||
    (declared.unit === "ml" &&
      (normalizedUnit === "ml" ||
        normalizedUnit === "l"));

  if (!compatible) {
    return {
      available: true,
      comparable: false,
      status: "UNIT REVIEW",
      declared: declared,
      measured: {
        value: measuredNumber,
        unit: normalizedUnit,
      },
      difference: null,
      differencePercent: null,
      message:
        "Declared and measured quantities use incompatible units. Verify the commodity and measurement unit before making a decision.",
    };
  }

  var difference = normalizedMeasured - declared.value;
  var absoluteDifference = Math.abs(difference);

  var differencePercent =
    declared.value > 0
      ? (absoluteDifference / declared.value) * 100
      : 0;

  /*
   * Do not apply a universal percentage tolerance here.
   * Legal quantity verification depends on the applicable commodity,
   * permissible error and the prescribed sampling/testing framework.
   * This screen therefore reports the arithmetic comparison and sends
   * the legal determination to inspector review.
   */
  var status = "REVIEW REQUIRED";
  var message;

  if (difference >= 0) {
    message =
      "The inspector-entered quantity is at or above the declared quantity. The arithmetic comparison is shown for evidence only; the applicable commodity-specific legal tolerance and testing procedure must be applied before enforcement.";
  } else {
    message =
      "The inspector-entered quantity is below the declared quantity by " +
      differencePercent.toFixed(2) +
      "%. This is a screening indication, not a statutory violation finding. Verify the instrument, applicable permissible error and prescribed testing procedure before making an enforcement decision.";
  }

  return {
    available: true,
    comparable: true,
    status: status,
    declared: declared,
    measured: {
      value: measuredNumber,
      unit: normalizedUnit,
    },
    normalizedMeasured: normalizedMeasured,
    difference: difference,
    differencePercent: differencePercent,
    message: message,
  };
}

function hasInspectionData(
  fields,
  physicalQuantity,
  physicalUnit
) {
  var fieldValues = Object.values(fields || {});

  var hasFields = fieldValues.some(function (value) {
    return String(value || "").trim().length > 0;
  });

  var hasQuantity =
    String(physicalQuantity || "").trim().length > 0;

  var hasUnit =
    String(physicalUnit || "").trim().length > 0;

  return hasFields || (hasQuantity && hasUnit);
}

function runCompliance(
  fields,
  physicalQuantity,
  physicalUnit
) {
  /*
   * PHASE 3 FIX:
   * A completely new inspection must not automatically become
   * NON-COMPLIANT merely because no fields have been scanned yet.
   */
  if (
    !hasInspectionData(
      fields,
      physicalQuantity,
      physicalUnit
    )
  ) {
    return [];
  }

  var results = RULES.map(function (rule) {
    var evaluation = rule.evaluate(fields);

    return {
      id: rule.id,
      title: rule.title,
      short: rule.short,
      severity: rule.severity,
      reference: rule.reference,
      description: rule.description,
      status: evaluation.status,
      message: evaluation.message,
    };
  });

  var quantityVerification =
    buildQuantityVerification(
      fields,
      physicalQuantity,
      physicalUnit
    );

  var quantityRule = results.find(function (item) {
    return item.id === "quantity";
  });

  if (
    quantityRule &&
    quantityVerification.available
  ) {
    quantityRule.status =
      quantityVerification.status === "PASS"
        ? "PASS"
        : "REVIEW REQUIRED";
    quantityRule.message =
      "Declared quantity is present. " +
      quantityVerification.message;
  }

  return results;
}

function scoreResults(results) {
  if (!results.length) {
    return 0;
  }

  var applicable = results.filter(function (item) {
    return item.status !== "NOT APPLICABLE";
  });

  if (!applicable.length) {
    return 0;
  }

  var passed = applicable.filter(function (item) {
    return item.status === "PASS";
  }).length;

  return Math.round(
    (passed / applicable.length) * 100
  );
}

function overallStatus(results) {
  if (!Array.isArray(results) || !results.length) {
    return "NOT SCANNED";
  }

  var applicable = results.filter(function (item) {
    return item.status !== "NOT APPLICABLE";
  });

  if (!applicable.length) {
    return "REVIEW REQUIRED";
  }

  var attentionRequired = applicable.some(function (item) {
    return item.status !== "PASS";
  });

  /*
   * OCR/rule screening can confirm that a declaration was detected,
   * but it must not automatically create an enforcement finding.
   * Missing or uncertain declarations therefore remain in inspector review.
   */
  return attentionRequired ? "REVIEW REQUIRED" : "COMPLIANT";
}

function Icon(props) {
  var name = props.name;
  var size = props.size || 20;

  var icons = {
    grid: "▦",
    scan: "⌁",
    history: "◷",
    info: "ⓘ",
    settings: "⚙",
    moon: "☾",
    sun: "☀",
    upload: "↑",
    camera: "▣",
    check: "✓",
    close: "×",
    arrow: "→",
    file: "▤",
    shield: "◇",
    warning: "!",
    search: "⌕",
    trash: "⌫",
    download: "↓",
    refresh: "↻",
    user: "●",
    plus: "+",
  };

  return (
    <span
      className="icon"
      style={{ fontSize: size }}
      aria-hidden="true"
    >
      {icons[name] || "•"}
    </span>
  );
}

function StatusBadge(props) {
  var status = props.status;

  var normalized = String(status)
    .toLowerCase()
    .replace(/\s/g, "-");

  return (
    <span
      className={
        "status-badge status-" +
        normalized
      }
    >
      <span className="status-dot" />
      {status}
    </span>
  );
}

function EmptyState(props) {
  return (
    <div className="empty-state">
      <div className="empty-icon">
        <Icon
          name={props.icon || "file"}
          size={28}
        />
      </div>

      <h3>{props.title}</h3>
      <p>{props.text}</p>

      {props.action}
    </div>
  );
}


function clampNumber(value, minimum, maximum) {
  var number = Number(value);
  if (!Number.isFinite(number)) return minimum;
  return Math.min(maximum, Math.max(minimum, number));
}

function getOCRConfidence(response) {
  var raw = response && response.data && Number(response.data.confidence);
  if (!Number.isFinite(raw)) return null;
  return Math.round(clampNumber(raw, 0, 100));
}

function getExtractionConfidence(fields, ocrConfidence) {
  var values = Object.values(fields || {});
  if (!values.length) return 0;
  var present = values.filter(function (value) {
    return String(value || "").trim().length > 0;
  }).length;
  var completeness = (present / values.length) * 100;
  if (ocrConfidence === null || ocrConfidence === undefined) {
    return Math.round(completeness);
  }
  return Math.round(clampNumber(
    Number(ocrConfidence) * 0.7 + completeness * 0.3,
    0,
    100
  ));
}

function buildInspectionIntelligence(fields, results, quantityVerification, ocrConfidence, decision, imagePreview) {
  var missing = FIELD_CONFIG.filter(function (item) {
    return !String(fields && fields[item[0]] || "").trim();
  }).map(function (item) {
    return item[1];
  });

  var failed = results.filter(function (item) {
    return (
      item.status !== "PASS" &&
      item.status !== "NOT APPLICABLE"
    );
  });

  var actions = [];
  if (!imagePreview) {
    actions.push("Capture or upload a clear package-label image.");
  }
  if (imagePreview && ocrConfidence !== null && ocrConfidence < 60) {
    actions.push("OCR confidence is low. Retake the label image with better lighting, focus and less glare.");
  }
  if (missing.length) {
    actions.push("Verify missing declaration fields manually before making the final decision.");
  }
  if (failed.length) {
    actions.push("Review every flagged rule and attach supporting evidence before making an enforcement decision.");
  }
  if (quantityVerification && quantityVerification.available && quantityVerification.status === "UNIT REVIEW") {
    actions.push("Resolve the declared-versus-measured unit mismatch before deciding compliance.");
  }
  if (quantityVerification && quantityVerification.available && quantityVerification.status === "REVIEW REQUIRED") {
    actions.push("Recheck the instrument reading and apply the commodity-specific legal tolerance.");
  }
  if (!actions.length && results.length) {
    actions.push("Screening checks are clear. Confirm the applicable commodity-specific requirements and inspector evidence before finalizing.");
  }

  var priority = failed.length ? failed.slice().sort(function (a, b) {
    var rank = { HIGH: 3, MEDIUM: 2, LOW: 1 };
    return (rank[b.severity] || 0) - (rank[a.severity] || 0);
  })[0] : null;

  var readiness = 0;
  if (imagePreview) readiness += 25;
  if (results.length) readiness += 25;
  if (!missing.length) readiness += 20;
  if (quantityVerification && quantityVerification.available && quantityVerification.comparable) readiness += 15;
  if (decision) readiness += 15;

  return {
    missing: missing,
    failed: failed,
    priority: priority,
    actions: actions,
    readiness: Math.round(clampNumber(readiness, 0, 100)),
  };
}

async function prepareImageForOCR(source) {
  /*
   * Tesseract can consume a lot of memory with modern phone photos.
   * Downscale large raster images before OCR while keeping enough detail
   * for package-label text. If the browser cannot decode the image, the
   * original source is returned and Tesseract gets a chance to handle it.
   */
  if (
    typeof window === "undefined" ||
    typeof document === "undefined" ||
    !(source instanceof Blob)
  ) {
    return source;
  }

  var objectUrl = "";

  try {
    objectUrl = URL.createObjectURL(source);

    var image = await new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () {
        resolve(img);
      };
      img.onerror = function () {
        reject(new Error("Image decode failed"));
      };
      img.src = objectUrl;
    });

    var width = image.naturalWidth || image.width;
    var height = image.naturalHeight || image.height;
    var maxDimension = 2000;

    if (!width || !height || Math.max(width, height) <= maxDimension) {
      return source;
    }

    var scale = maxDimension / Math.max(width, height);
    var outputWidth = Math.max(1, Math.round(width * scale));
    var outputHeight = Math.max(1, Math.round(height * scale));
    var canvas = document.createElement("canvas");
    canvas.width = outputWidth;
    canvas.height = outputHeight;

    var context = canvas.getContext("2d", { alpha: false });

    if (!context) {
      return source;
    }

    context.drawImage(image, 0, 0, outputWidth, outputHeight);

    var blob = await new Promise(function (resolve) {
      canvas.toBlob(
        function (value) {
          resolve(value);
        },
        "image/jpeg",
        0.9
      );
    });

    return blob || source;
  } catch (error) {
    console.warn("MetroCheck OCR preprocessing skipped:", error);
    return source;
  } finally {
    if (objectUrl) {
      try {
        URL.revokeObjectURL(objectUrl);
      } catch (error) {
        console.error(error);
      }
    }
  }
}

function getEnvironmentReadiness() {
  var secure = typeof window !== "undefined" && !!window.isSecureContext;
  var storage = false;
  try {
    var key = "metrocheck_storage_test";
    localStorage.setItem(key, "1");
    localStorage.removeItem(key);
    storage = true;
  } catch (error) {
    storage = false;
  }
  return { secure: secure, storage: storage, cloud: supabaseReady };
}

function App() {
  var [page, setPage] =
    useState("dashboard");

  var [darkMode, setDarkMode] =
    useState(false);

  /*
   * PHASE 4: Settings and inspector profile panel.
   */
  var [settingsOpen, setSettingsOpen] =
    useState(false);

  var [settingsView, setSettingsView] =
    useState("settings");

  var [inspectionId, setInspectionId] =
    useState(makeInspectionId());

  /*
   * PHASE 3:
   * Keep the inspection's original creation timestamp so
   * reopening an old record does not change its PDF date/time.
   */
  var [inspectionTimestamp, setInspectionTimestamp] =
    useState(Date.now());

  var [imageFile, setImageFile] =
    useState(null);

  var [imagePreview, setImagePreview] =
    useState("");

  /*
   * PHASE 4:
   * A packaged commodity may have relevant declarations
   * across different panels. Keep front and back images
   * together as one inspection.
   */
  var [packageImages, setPackageImages] =
    useState({
      front: null,
      back: null,
    });

  var [selectedImageSide, setSelectedImageSide] =
    useState("front");

  var [ocrText, setOcrText] =
    useState("");

  var [fields, setFields] = useState(
    Object.assign({}, EMPTY_FIELDS)
  );

  var [physicalQuantity, setPhysicalQuantity] =
    useState("");

  var [physicalUnit, setPhysicalUnit] =
    useState("g");

  var [evidence, setEvidence] =
    useState([]);

  var [decision, setDecision] =
    useState("");

  var [notes, setNotes] =
    useState("");

  var initialAccounts = useMemo(function () {
    return loadInspectorAccounts();
  }, []);

  var initialInspectorId = getCurrentInspectorId(initialAccounts);
  var initialInspector =
    initialAccounts.find(function (account) {
      return account.id === initialInspectorId;
    }) || initialAccounts[0] || DEFAULT_INSPECTOR;

  var [inspectorAccounts, setInspectorAccounts] =
    useState(initialAccounts);

  var [currentInspectorId, setCurrentInspectorId] =
    useState(initialInspector.id);

  var [inspector, setInspector] =
    useState(
      Object.assign({}, initialInspector)
    );

  var initialAuthId = getAuthSessionId();
  var initialAuthenticatedAccount =
    initialAccounts.find(function (account) {
      return account.id === initialAuthId && account.verified;
    });

  var [authenticatedInspectorId, setAuthenticatedInspectorId] =
    useState(
      supabaseReady
        ? ""
        : initialAuthenticatedAccount
        ? initialAuthenticatedAccount.id
        : ""
    );

  var [supabaseUserUid, setSupabaseUserUid] =
    useState("");

  var [authInitializing, setAuthInitializing] =
    useState(supabaseReady);

  var [scanState, setScanState] =
    useState("idle");

  var [scanProgress, setScanProgress] =
    useState(0);

  var [ocrConfidence, setOCRConfidence] =
    useState(null);

  var [fieldSources, setFieldSources] =
    useState({});

  var [toast, setToast] =
    useState("");

  var [history, setHistory] =
    useState([]);

  var [historySearch, setHistorySearch] =
    useState("");

  var [historyFilter, setHistoryFilter] =
    useState("ALL");

  var [cameraOpen, setCameraOpen] =
    useState(false);

  var [cameraError, setCameraError] =
    useState("");

  var [cameraReady, setCameraReady] =
    useState(false);

  var videoRef = useRef(null);
  var streamRef = useRef(null);
  var frontCameraInputRef = useRef(null);
  var backCameraInputRef = useRef(null);
  var activeCameraSideRef = useRef("front");

  useEffect(function () {
    if (supabaseReady) {
      return;
    }

    var allHistory = getAllStoredHistory();
    var migrated = allHistory.map(function (record) {
      var ownerId = getHistoryOwnerId(record);
      var normalized = normalizeHistoryRecord(
        Object.assign({}, record, { ownerId: ownerId })
      );

      return normalized;
    });

    saveAllStoredHistory(migrated);

    var visibleHistory = migrated
      .filter(function (record) {
        return getHistoryOwnerId(record) === currentInspectorId;
      })
      .sort(function (a, b) {
        return getRecordTimestamp(b) - getRecordTimestamp(a);
      });

    setHistory(visibleHistory);
  }, [currentInspectorId]);

  useEffect(function () {
    if (supabaseReady) {
      return;
    }

    saveInspectorAccounts(inspectorAccounts);
    saveCurrentInspectorId(currentInspectorId);
  }, [inspectorAccounts, currentInspectorId]);

  useEffect(function () {
    if (!supabaseReady) {
      setAuthInitializing(false);
      return undefined;
    }

    var cancelled = false;

    var unsubscribe = observeAuthSession(async function (user) {
      if (cancelled) {
        return;
      }

      if (!user) {
        setSupabaseUserUid("");
        setAuthenticatedInspectorId("");
        setHistory([]);
        setAuthInitializing(false);
        return;
      }

      try {
        var profile = await getInspectorProfile(user.id);

        if (!profile || !profile.verified) {
          await logoutInspectorFromSupabase();
          if (!cancelled) {
            setSupabaseUserUid("");
            setAuthenticatedInspectorId("");
            setAuthInitializing(false);
            setToast(
              "This Supabase account does not have a verified MetroCheck inspector profile."
            );
          }
          return;
        }

        if (cancelled) {
          return;
        }

        setSupabaseUserUid(user.id);
        setCurrentInspectorId(profile.id);
        setInspector(Object.assign({}, profile));
        setInspectorAccounts([Object.assign({}, profile)]);
        setAuthenticatedInspectorId(profile.id);
        setAuthInitializing(false);
      } catch (error) {
        console.error("MetroCheck Supabase session restore failed:", error);
        if (!cancelled) {
          setSupabaseUserUid("");
          setAuthenticatedInspectorId("");
          setAuthInitializing(false);
          setToast("Could not restore the MetroCheck cloud session.");
        }
      }
    });

    return function () {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  /*
   * Startup failsafe: never leave the application stuck on the session-restoring
   * screen indefinitely if a browser extension/network issue prevents Supabase
   * from answering. Normal auth restoration usually completes almost instantly.
   */
  useEffect(function () {
    if (!supabaseReady || !authInitializing) {
      return undefined;
    }

    var timer = window.setTimeout(function () {
      setAuthInitializing(false);
    }, 8000);

    return function () {
      window.clearTimeout(timer);
    };
  }, [authInitializing]);

  useEffect(function () {
    if (!supabaseReady || !supabaseUserUid) {
      return undefined;
    }

    var cancelled = false;

    loadCloudHistory(supabaseUserUid)
      .then(function (records) {
        if (cancelled) {
          return;
        }

        setHistory(
          records.map(normalizeHistoryRecord).sort(function (a, b) {
            return getRecordTimestamp(b) - getRecordTimestamp(a);
          })
        );
      })
      .catch(function (error) {
        console.error("MetroCheck cloud history load failed:", error);
        if (!cancelled) {
          setToast("Could not load inspection history from Supabase.");
        }
      });

    return function () {
      cancelled = true;
    };
  }, [supabaseUserUid]);

  useEffect(
    function () {
      document.body.className = darkMode
        ? "dark-mode"
        : "";
    },
    [darkMode]
  );

  useEffect(
    function () {
      if (!toast) {
        return undefined;
      }

      var timer = setTimeout(function () {
        setToast("");
      }, 3000);

      return function () {
        clearTimeout(timer);
      };
    },
    [toast]
  );

  useEffect(
    function () {
      if (!settingsOpen) {
        return undefined;
      }

      function handleSettingsKeyDown(event) {
        if (event.key === "Escape") {
          setSettingsOpen(false);
        }
      }

      window.addEventListener(
        "keydown",
        handleSettingsKeyDown
      );

      return function () {
        window.removeEventListener(
          "keydown",
          handleSettingsKeyDown
        );
      };
    },
    [settingsOpen]
  );

  useEffect(function () {
    if (!cameraOpen) {
      return undefined;
    }

    var video = videoRef.current;
    var stream = streamRef.current;

    if (!video || !stream) {
      return undefined;
    }

    video.srcObject = stream;

    function markReady() {
      if (video.videoWidth > 0 && video.videoHeight > 0) {
        setCameraReady(true);
      }
    }

    video.addEventListener("loadedmetadata", markReady);
    video.addEventListener("canplay", markReady);

    var playPromise = video.play();

    if (playPromise && typeof playPromise.catch === "function") {
      playPromise.catch(function (error) {
        console.warn("Camera preview play was delayed:", error);
      });
    }

    markReady();

    return function () {
      video.removeEventListener("loadedmetadata", markReady);
      video.removeEventListener("canplay", markReady);

      if (video.srcObject === stream) {
        video.srcObject = null;
      }
    };
  }, [cameraOpen]);

  useEffect(function () {
    return function () {
      if (streamRef.current) {
        streamRef.current
          .getTracks()
          .forEach(function (track) {
            track.stop();
          });

        streamRef.current = null;
      }

      if (videoRef.current) {
        videoRef.current.srcObject = null;
      }
    };
  }, []);

  var results = useMemo(
    function () {
      return runCompliance(
        fields,
        physicalQuantity,
        physicalUnit
      );
    },
    [
      fields,
      physicalQuantity,
      physicalUnit,
    ]
  );

  var quantityVerification = useMemo(
    function () {
      return buildQuantityVerification(
        fields,
        physicalQuantity,
        physicalUnit
      );
    },
    [
      fields,
      physicalQuantity,
      physicalUnit,
    ]
  );

  var score = useMemo(
    function () {
      return scoreResults(results);
    },
    [results]
  );

  var status = useMemo(
    function () {
      return overallStatus(results);
    },
    [results]
  );

  var extractionConfidence = useMemo(
    function () {
      return getExtractionConfidence(
        fields,
        ocrConfidence
      );
    },
    [fields, ocrConfidence]
  );

  var intelligence = useMemo(
    function () {
      return buildInspectionIntelligence(
        fields,
        results,
        quantityVerification,
        ocrConfidence,
        decision,
        imagePreview
      );
    },
    [fields, results, quantityVerification, ocrConfidence, decision, imagePreview]
  );

  var environmentReadiness = useMemo(
    function () {
      return getEnvironmentReadiness();
    },
    []
  );

  var passedCount =
    results.filter(function (item) {
      return item.status === "PASS";
    }).length;

  var failedCount =
    results.filter(function (item) {
      return (
        item.status !== "PASS" &&
        item.status !== "NOT APPLICABLE"
      );
    }).length;

  var filteredHistory = useMemo(
    function () {
      return history.filter(function (item) {
        var search =
          historySearch.toLowerCase();

        var matchesSearch =
          !search ||
          (
            String(item.id || "") +
            " " +
            String(item.productName || "") +
            " " +
            String(item.status || "") +
            " " +
            String(item.date || "") +
            " " +
            String(item.inspector && item.inspector.name || "") +
            " " +
            String(item.inspector && item.inspector.id || "")
          )
            .toLowerCase()
            .includes(search);

        var matchesFilter =
          historyFilter === "ALL" ||
          item.status === historyFilter;

        return (
          matchesSearch &&
          matchesFilter
        );
      });
    },
    [
      history,
      historySearch,
      historyFilter,
    ]
  );

  function navigate(target) {
    setPage(target);

    window.scrollTo({
      top: 0,
      behavior: "smooth",
    });
  }

  function showToast(message) {
    setToast(message);
  }

  function openSettings(view) {
    setSettingsView(view || "settings");
    setSettingsOpen(true);
  }

  function closeSettings() {
    setSettingsOpen(false);
  }

  function resetInspection() {
    stopCamera();

    if (
      imagePreview &&
      imagePreview.startsWith("blob:")
    ) {
      URL.revokeObjectURL(
        imagePreview
      );
    }

    setInspectionId(
      makeInspectionId()
    );

    setInspectionTimestamp(
      Date.now()
    );

    setImageFile(null);
    setImagePreview("");
    setPackageImages({
      front: null,
      back: null,
    });
    setSelectedImageSide("front");
    setOcrText("");

    setFields(
      Object.assign({}, EMPTY_FIELDS)
    );

    setPhysicalQuantity("");
    setPhysicalUnit("g");

    setEvidence([]);
    setDecision("");
    setNotes("");

    setScanState("idle");
    setScanProgress(0);
    setOCRConfidence(null);
    setFieldSources({});

    setCameraOpen(false);
    setCameraError("");
    setCameraReady(false);
  }

  function startNewInspection() {
    resetInspection();
    navigate("scanner");
  }

  function handleImage(file, side) {
    if (!file) {
      return;
    }

    var fileType = String(file.type || "").toLowerCase();
    var fileName = String(file.name || "").toLowerCase();
    var looksLikeImage =
      fileType.startsWith("image/") ||
      /\.(jpe?g|png|webp|heic|heif)$/i.test(fileName);

    if (!looksLikeImage) {
      showToast(
        "Please select a JPG, PNG, WEBP, HEIC or HEIF image."
      );
      return;
    }

    /*
     * Very large phone photos can exhaust browser memory while OCR is
     * running. Keep the original for preview, but reject unusually large
     * files before they can crash a mobile tab.
     */
    if (Number(file.size || 0) > 25 * 1024 * 1024) {
      showToast(
        "This image is larger than 25 MB. Please capture or choose a smaller image."
      );
      return;
    }

    var targetSide =
      side === "back"
        ? "back"
        : side === "front"
        ? "front"
        : selectedImageSide;

    var previewUrl;

    try {
      previewUrl = URL.createObjectURL(file);
    } catch (error) {
      console.error("MetroCheck image preview failed:", error);
      showToast(
        "This image could not be opened by the browser. Please try another photo."
      );
      return;
    }

    setPackageImages(function (previous) {
      var previousImage = previous[targetSide];

      if (
        previousImage &&
        previousImage.preview &&
        previousImage.preview.startsWith("blob:")
      ) {
        try {
          URL.revokeObjectURL(previousImage.preview);
        } catch (error) {
          console.error(error);
        }
      }

      return Object.assign({}, previous, {
        [targetSide]: {
          file: file,
          preview: previewUrl,
        },
      });
    });

    /*
     * Keep the legacy single-image state pointed at the newest selected
     * panel so the rest of the existing workflow remains compatible.
     */
    setImageFile(file);
    setImagePreview(previewUrl);
    setSelectedImageSide(targetSide);
    activeCameraSideRef.current = targetSide;

    setScanState("ready");
    setScanProgress(0);
    setOcrText("");
    setOCRConfidence(null);
    setFieldSources({});
    setFields(Object.assign({}, EMPTY_FIELDS));

    showToast(
      (targetSide === "front" ? "Front" : "Back") +
        " package image loaded."
    );
  }

  function openCamera(side) {
    var targetSide = side === "back" ? "back" : "front";

    /*
     * Camera ownership is intentionally kept inside CameraModal.
     * The modal is mounted FIRST, then it requests getUserMedia. This avoids
     * the old race where permission/stream creation happened before the
     * <video> element existed, which could leave a black or blank camera view
     * on Safari, Chrome and mobile browsers.
     */
    activeCameraSideRef.current = targetSide;
    setSelectedImageSide(targetSide);
    setCameraError("");
    setCameraReady(false);
    setCameraOpen(true);
  }

  function handleCameraFile(file, side) {
    if (!file) {
      return;
    }

    var targetSide = side === "back" ? "back" : "front";
    activeCameraSideRef.current = targetSide;
    setSelectedImageSide(targetSide);
    handleImage(file, targetSide);
    setCameraOpen(false);
    setCameraError("");
    setCameraReady(false);
  }

  function stopCamera() {
    if (streamRef.current) {
      streamRef.current
        .getTracks()
        .forEach(function (track) {
          track.stop();
        });

      streamRef.current = null;
    }

    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }

    setCameraReady(false);
  }

  function closeCamera() {
    stopCamera();

    setCameraOpen(false);
    setCameraError("");
  }

  function capturePhoto() {
    var video = videoRef.current;

    if (!video || !cameraReady) {
      showToast(
        "Camera is not ready yet."
      );
      return;
    }

    var width = video.videoWidth;
    var height = video.videoHeight;

    if (!width || !height) {
      showToast(
        "Camera image is not available yet."
      );
      return;
    }

    var canvas =
      document.createElement("canvas");

    canvas.width = width;
    canvas.height = height;

    var context =
      canvas.getContext("2d");

    if (!context) {
      showToast(
        "Could not prepare camera capture."
      );
      return;
    }

    context.drawImage(
      video,
      0,
      0,
      width,
      height
    );

    function finishCapture(blob) {
      if (!blob) {
        showToast(
          "Could not capture the camera image."
        );
        return;
      }

      try {
        var captureSide =
          activeCameraSideRef.current === "back"
            ? "back"
            : "front";

        var file =
          typeof File === "function"
            ? new File(
                [blob],
                "MetroCheck-" +
                  captureSide +
                  "-Capture-" +
                  Date.now() +
                  ".jpg",
                {
                  type: "image/jpeg",
                }
              )
            : new Blob([blob], {
                type: "image/jpeg",
              });

        var previousImage =
          packageImages[captureSide];

        if (
          previousImage &&
          previousImage.preview &&
          previousImage.preview.startsWith("blob:")
        ) {
          URL.revokeObjectURL(
            previousImage.preview
          );
        }

        var previewUrl =
          URL.createObjectURL(file);

        var nextImages = Object.assign(
          {},
          packageImages,
          {
            [captureSide]: {
              file: file,
              preview: previewUrl,
            },
          }
        );

        setPackageImages(nextImages);
        setImageFile(file);
        setImagePreview(previewUrl);

        setScanState("ready");
        setScanProgress(0);
        setOcrText("");
        setOCRConfidence(null);
        setFieldSources({});

        setFields(
          Object.assign(
            {},
            EMPTY_FIELDS
          )
        );

        closeCamera();

        showToast(
          (captureSide === "front"
            ? "Front"
            : "Back") +
            " photo captured successfully."
        );
      } catch (error) {
        console.error(
          "MetroCheck camera capture failed:",
          error
        );
        showToast(
          "The photo could not be saved. Please try again."
        );
      }
    }

    try {
      if (typeof canvas.toBlob === "function") {
        canvas.toBlob(
          function (blob) {
            finishCapture(blob);
          },
          "image/jpeg",
          0.92
        );
      } else {
        var dataUrl = canvas.toDataURL(
          "image/jpeg",
          0.92
        );

        var parts = dataUrl.split(",");
        var binary = atob(parts[1]);
        var bytes = new Uint8Array(
          binary.length
        );

        for (
          var index = 0;
          index < binary.length;
          index += 1
        ) {
          bytes[index] = binary.charCodeAt(index);
        }

        finishCapture(
          new Blob([bytes], {
            type: "image/jpeg",
          })
        );
      }
    } catch (error) {
      console.error(
        "MetroCheck camera capture failed:",
        error
      );
      showToast(
        "The camera could not create an image. Please try again."
      );
    }
  }

  async function runOCR() {
    var imagesToScan = [
      {
        side: "front",
        item: packageImages.front,
      },
      {
        side: "back",
        item: packageImages.back,
      },
    ].filter(function (entry) {
      return (
        entry.item &&
        entry.item.preview
      );
    });

    /*
     * Compatibility with older single-image state.
     */
    if (
      imagesToScan.length === 0 &&
      imagePreview
    ) {
      imagesToScan = [
        {
          side: selectedImageSide,
          item: {
            preview: imagePreview,
          },
        },
      ];
    }

    if (imagesToScan.length === 0) {
      showToast(
        "Capture or upload the front and/or back package image first."
      );
      return;
    }

    setScanState("scanning");
    setScanProgress(5);
    setOcrText("");

    var worker = null;

    try {
      worker =
        await createWorker("eng");

      var collectedText = [];
      var confidenceValues = [];

      for (
        var index = 0;
        index < imagesToScan.length;
        index += 1
      ) {
        var entry =
          imagesToScan[index];

        setScanProgress(
          Math.min(
            90,
            10 +
              Math.round(
                (index /
                  imagesToScan.length) *
                  70
              )
          )
        );

        var sourceForOCR =
          entry.item.file ||
          entry.item.preview;

        var preparedSource =
          await prepareImageForOCR(
            sourceForOCR
          );

        var response =
          await worker.recognize(
            preparedSource
          );

        var sideText = normalizeText(
          response &&
            response.data
            ? response.data.text
            : ""
        );

        if (sideText) {
          collectedText.push(
            "===== " +
              entry.side.toUpperCase() +
              " SIDE =====\n" +
              sideText
          );
        }

        var sideConfidence =
          getOCRConfidence(response);

        if (
          sideConfidence !== null &&
          sideConfidence !== undefined
        ) {
          confidenceValues.push(
            Number(sideConfidence)
          );
        }
      }

      setScanProgress(92);

      var combinedText =
        collectedText.join("\n\n");

      var averageConfidence =
        confidenceValues.length
          ? Math.round(
              confidenceValues.reduce(
                function (sum, value) {
                  return sum + value;
                },
                0
              ) /
                confidenceValues.length
            )
          : null;

      setOCRConfidence(
        averageConfidence
      );
      setOcrText(combinedText);

      var extracted =
        extractFields(combinedText);
      var extractedSources = {};

      Object.keys(extracted).forEach(
        function (key) {
          if (
            String(
              extracted[key] || ""
            ).trim()
          ) {
            extractedSources[key] =
              "OCR";
          }
        }
      );

      setFieldSources(
        extractedSources
      );
      setFields(extracted);

      setScanProgress(100);
      setScanState("complete");

      showToast(
        imagesToScan.length === 2
          ? "Front and back package images analyzed successfully."
          : "Package image analyzed successfully."
      );
    } catch (error) {
      console.error(error);

      setScanState("error");

      showToast(
        "OCR could not process the package images. You can enter fields manually."
      );
    } finally {
      if (worker) {
        try {
          await worker.terminate();
        } catch (error) {
          console.error(error);
        }
      }
    }
  }

  function updateField(key, value) {
    setFields(function (previous) {
      return Object.assign(
        {},
        previous,
        {
          [key]: value,
        }
      );
    });

    setFieldSources(function (previous) {
      return Object.assign(
        {},
        previous,
        {
          [key]: "MANUAL",
        }
      );
    });
  }

  function updateInspector(key, value) {
    var nextValue = String(value || "");

    setInspector(function (previous) {
      return Object.assign(
        {},
        previous,
        {
          [key]: nextValue,
        }
      );
    });

    if (key === "name") {
      setInspectorAccounts(function (previous) {
        return previous.map(function (account) {
          return account.id === currentInspectorId
            ? Object.assign({}, account, { name: nextValue })
            : account;
        });
      });
    }

    if (supabaseReady && supabaseUserUid) {
      updateInspectorProfile(supabaseUserUid, { [key]: nextValue }).catch(
        function (error) {
          console.error("MetroCheck profile update failed:", error);
          showToast("Profile change could not be synced to Supabase.");
        }
      );
    }
  }

  async function registerInspector(registration) {
    var cleanId = String(
      registration && registration.id || ""
    ).trim().toUpperCase();
    var cleanEmail = String(
      registration && registration.email || ""
    ).trim().toLowerCase();
    var password = String(
      registration && registration.password || ""
    );

    var registryRecord = GOVERNMENT_INSPECTOR_REGISTRY.find(
      function (record) {
        return (
          record.id.toUpperCase() === cleanId &&
          record.email.toLowerCase() === cleanEmail
        );
      }
    );

    if (!cleanId || !cleanEmail || !password) {
      showToast(
        "Enter the government inspector ID, official email and password."
      );
      return false;
    }

    if (password.length < 6) {
      showToast("Password must contain at least 6 characters.");
      return false;
    }

    if (!registryRecord) {
      showToast(
        "Inspector could not be verified against the government registry."
      );
      return false;
    }

    if (supabaseReady) {
      try {
        var registered = await registerInspectorWithSupabase(
          registryRecord,
          password
        );

        if (registered.confirmationRequired || !registered.profile) {
          showToast(
            "Account created. Confirm the email if Supabase email confirmation is enabled, then sign in."
          );
          return true;
        }

        var cloudAccount = Object.assign({}, registered.profile);

        setSupabaseUserUid(registered.user.id);
        setInspectorAccounts([cloudAccount]);
        setCurrentInspectorId(cloudAccount.id);
        setInspector(cloudAccount);
        setAuthenticatedInspectorId(cloudAccount.id);
        setSettingsOpen(false);
        resetInspection();
        showToast("Inspector verified and cloud account created.");
        return true;
      } catch (error) {
        console.error("MetroCheck Supabase registration failed:", error);
        var errorText = String(
          error && error.message ? error.message : ""
        ).toLowerCase();
        var registrationMessage =
          errorText.includes("already") ||
          errorText.includes("registered") ||
          errorText.includes("exists")
            ? "This official email is already registered. Please sign in."
            : errorText.includes("inspector") || errorText.includes("registry")
            ? "This inspector is not approved in the MetroCheck Supabase registry."
            : "Could not create the Supabase inspector account. Check your Supabase setup and try again.";
        showToast(registrationMessage);
        return false;
      }
    }

    var existing = inspectorAccounts.find(
      function (account) {
        return account.id === registryRecord.id;
      }
    );

    if (existing && existing.verified) {
      showToast(
        "This inspector is already registered. Please sign in."
      );
      return false;
    }

    var account = Object.assign(
      {},
      registryRecord,
      {
        password: password,
        verified: true,
        verifiedAt: Date.now(),
      }
    );

    var updatedAccounts = inspectorAccounts.filter(
      function (item) {
        return item.id !== account.id;
      }
    ).concat([account]);

    saveInspectorAccounts(updatedAccounts);
    saveCurrentInspectorId(account.id);
    saveAuthSessionId(account.id);

    setInspectorAccounts(updatedAccounts);
    setCurrentInspectorId(account.id);
    setInspector(Object.assign({}, account));
    setAuthenticatedInspectorId(account.id);
    setSettingsOpen(false);
    resetInspection();
    showToast(
      "Inspector verified. Welcome to MetroCheck."
    );

    return true;
  }

  function demoLogin() {
    setSupabaseUserUid("");

    var demoAccount = inspectorAccounts.find(function (account) {
      return account.id === "INS-001";
    }) || {
      id: "INS-001",
      name: "Inspector",
      email: "inspector@demo.metrology.gov.in",
      department: "Legal Metrology Department",
      office: "West Godavari",
      verified: true,
    };

    saveCurrentInspectorId(demoAccount.id);
    saveAuthSessionId(demoAccount.id);
    setCurrentInspectorId(demoAccount.id);
    setInspector(Object.assign({}, demoAccount));
    setAuthenticatedInspectorId(demoAccount.id);
    setSettingsOpen(false);
    resetInspection();
    showToast("Demo Inspector signed in.");
  }

  async function loginInspector(email, password) {
    var cleanEmail = String(email || "").trim().toLowerCase();
    var cleanPassword = String(password || "");

    if (supabaseReady) {
      try {
        var loggedIn = await loginInspectorWithSupabase(
          cleanEmail,
          cleanPassword
        );
        var cloudAccount = Object.assign({}, loggedIn.profile);

        setSupabaseUserUid(loggedIn.user.id);
        setInspectorAccounts([cloudAccount]);
        setCurrentInspectorId(cloudAccount.id);
        setInspector(cloudAccount);
        setAuthenticatedInspectorId(cloudAccount.id);
        resetInspection();
        showToast("Welcome back, " + cloudAccount.name + ".");
        return true;
      } catch (error) {
        console.error("MetroCheck Supabase login failed:", error);
        showToast(
          "Invalid Supabase account details or the inspector profile is not verified."
        );
        return false;
      }
    }

    var account = inspectorAccounts.find(
      function (item) {
        return (
          item.email &&
          item.email.toLowerCase() === cleanEmail &&
          item.password === cleanPassword &&
          item.verified
        );
      }
    );

    if (!account) {
      showToast(
        "Invalid MetroCheck account details. Please verify your email and password."
      );
      return false;
    }

    saveCurrentInspectorId(account.id);
    saveAuthSessionId(account.id);
    setCurrentInspectorId(account.id);
    setInspector(Object.assign({}, account));
    setAuthenticatedInspectorId(account.id);
    resetInspection();
    showToast("Welcome back, " + account.name + ".");
    return true;
  }

  async function logoutInspector() {
    stopCamera();

    if (supabaseReady && supabaseUserUid) {
      try {
        await logoutInspectorFromSupabase();
      } catch (error) {
        console.error("MetroCheck Supabase logout failed:", error);
      }
    }

    saveAuthSessionId("");
    setSupabaseUserUid("");
    setAuthenticatedInspectorId("");
    setHistory([]);
    setSettingsOpen(false);
    setPage("dashboard");
    showToast("Signed out of MetroCheck.");
  }

  function handleEvidence(files) {
    var selected =
      Array.from(files || []);

    var list =
      selected.map(function (file) {
        return {
          id:
            file.name +
            "-" +
            file.lastModified +
            "-" +
            Math.random(),

          name: file.name,
          size: file.size,
          type: file.type,
          addedAt: Date.now(),
          file: file,
        };
      });

    setEvidence(function (previous) {
      return previous.concat(list);
    });

    if (list.length) {
      showToast(
        String(list.length) +
          " evidence file(s) added."
      );
    }
  }

  function removeEvidence(id) {
    setEvidence(function (previous) {
      return previous.filter(
        function (item) {
          return item.id !== id;
        }
      );
    });
  }

  async function saveInspection() {
    if (
      !hasInspectionData(
        fields,
        physicalQuantity,
        physicalUnit
      )
    ) {
      showToast(
        "Add or scan declaration information before saving the inspection."
      );
      return;
    }

    var finalResults =
      runCompliance(
        fields,
        physicalQuantity,
        physicalUnit
      );

    var finalScore =
      scoreResults(finalResults);

    var automatedStatus =
      overallStatus(finalResults);

    var finalStatus =
      decision ||
      automatedStatus;

    /*
     * If this is an old record, preserve its original timestamp.
     * If it is a genuinely new record, preserve the timestamp
     * already created for this inspection.
     */
    var savedTimestamp =
      inspectionTimestamp || Date.now();

    var savedDate =
      new Date(savedTimestamp);

    var record = {
      id: inspectionId,

      ownerId: currentInspectorId,

      productName:
        fields.productName ||
        "Unknown commodity",

      imagePreview:
        imagePreview,

      packageImages:
        {
          front:
            packageImages.front
              ? packageImages.front.preview
              : "",
          back:
            packageImages.back
              ? packageImages.back.preview
              : "",
        },

      fields:
        Object.assign({}, fields),

      ocrText:
        ocrText,

      physicalQuantity:
        physicalQuantity,

      physicalUnit:
        physicalUnit,

      quantityVerification:
        quantityVerification,

      inspector:
        Object.assign(
          {},
          inspector
        ),

      evidence:
        evidence,

      decision:
        finalStatus,

      status:
        finalStatus,

      automatedStatus:
        automatedStatus,

      score:
        finalScore,

      ocrConfidence:
        ocrConfidence,

      extractionConfidence:
        extractionConfidence,

      ruleResults:
        finalResults,

      notes:
        notes,

      date:
        formatDate(savedDate),

      time:
        formatTime(savedDate),

      timestamp:
        savedTimestamp,
    };

    if (supabaseReady && supabaseUserUid) {
      try {
        showToast("Saving inspection to Supabase…");

        var cloudRecord = await saveCloudInspection(
          record,
          packageImages,
          evidence,
          supabaseUserUid
        );

        var normalizedCloudRecord = normalizeHistoryRecord(cloudRecord);

        setHistory(function (previous) {
          return [
            normalizedCloudRecord,
            ...previous.filter(function (item) {
              return item.id !== inspectionId;
            }),
          ].sort(function (a, b) {
            return getRecordTimestamp(b) - getRecordTimestamp(a);
          });
        });

        setImagePreview(normalizedCloudRecord.imagePreview || "");
        setPackageImages({
          front: normalizedCloudRecord.packageImages && normalizedCloudRecord.packageImages.front
            ? { file: null, preview: normalizedCloudRecord.packageImages.front }
            : null,
          back: normalizedCloudRecord.packageImages && normalizedCloudRecord.packageImages.back
            ? { file: null, preview: normalizedCloudRecord.packageImages.back }
            : null,
        });
        setEvidence(normalizedCloudRecord.evidence || []);
        setDecision(finalStatus);
        showToast("Inspection saved securely to Supabase.");
        navigate("history");
        return;
      } catch (error) {
        console.error("MetroCheck cloud inspection save failed:", error);
        showToast(
          "Inspection could not be saved to Supabase. Check your connection and Supabase rules."
        );
        return;
      }
    }

    var normalizedRecord =
      normalizeHistoryRecord(record);

    var allHistory = getAllStoredHistory();
    var nextAll = [
      normalizedRecord,
      ...allHistory.filter(function (item) {
        return item.id !== inspectionId;
      }),
    ].sort(function (a, b) {
      return getRecordTimestamp(b) - getRecordTimestamp(a);
    });

    if (!saveAllStoredHistory(nextAll)) {
      showToast(
        "Inspection was processed, but browser storage is full."
      );
      return;
    }

    var nextVisible = nextAll.filter(function (item) {
      return getHistoryOwnerId(item) === currentInspectorId;
    });

    setHistory(nextVisible);

    setDecision(finalStatus);

    showToast(
      "Inspection saved to history."
    );

    navigate("history");
  }

  function loadInspection(record) {
    var normalizedRecord =
      normalizeHistoryRecord(record);

    setInspectionId(
      normalizedRecord.id
    );

    /*
     * PHASE 3 FIX:
     * Restore the saved timestamp when available.
     * Older records that do not have timestamp fall back
     * to the current time only as a compatibility fallback.
     */
    setInspectionTimestamp(
      normalizedRecord.timestamp
    );

    setImagePreview(
      (normalizedRecord.imagePreview &&
      !String(normalizedRecord.imagePreview).startsWith("blob:")
        ? normalizedRecord.imagePreview
        : "")
    );

    setImageFile(null);

    var savedPackageImages =
      normalizedRecord.packageImages || {
        front: "",
        back: "",
      };

    setPackageImages({
      front:
        savedPackageImages.front &&
        !String(savedPackageImages.front).startsWith("blob:")
          ? {
              file: null,
              preview:
                savedPackageImages.front,
            }
          : null,
      back:
        savedPackageImages.back &&
        !String(savedPackageImages.back).startsWith("blob:")
          ? {
              file: null,
              preview:
                savedPackageImages.back,
            }
          : null,
    });

    setSelectedImageSide(
      savedPackageImages.back &&
      !savedPackageImages.front
        ? "back"
        : "front"
    );

    setFields(
      normalizedRecord.fields
    );

    setOcrText(
      normalizedRecord.ocrText || ""
    );

    setOCRConfidence(
      normalizedRecord.ocrConfidence !== null &&
      normalizedRecord.ocrConfidence !== undefined
        ? Number(normalizedRecord.ocrConfidence)
        : null
    );

    setFieldSources({});

    setPhysicalQuantity(
      normalizedRecord.physicalQuantity ||
        ""
    );

    setPhysicalUnit(
      normalizedRecord.physicalUnit ||
        "g"
    );

    setEvidence(
      normalizedRecord.evidence
    );

    setDecision(
      normalizedRecord.decision ||
        normalizedRecord.status ||
        ""
    );

    setNotes(
      normalizedRecord.notes || ""
    );

    setInspector(
      normalizedRecord.inspector
    );

    setScanState(
      normalizedRecord.imagePreview &&
      !String(normalizedRecord.imagePreview).startsWith("blob:")
        ? "complete"
        : "idle"
    );

    setScanProgress(
      normalizedRecord.imagePreview &&
      !String(normalizedRecord.imagePreview).startsWith("blob:")
        ? 100
        : 0
    );

    navigate("scanner");
  }

  async function deleteInspection(id) {
    if (supabaseReady && supabaseUserUid) {
      try {
        await deleteCloudInspection(id, supabaseUserUid);
        setHistory(function (previous) {
          return previous.filter(function (item) {
            return item.id !== id;
          });
        });
        showToast("Inspection removed from Supabase.");
      } catch (error) {
        console.error("MetroCheck cloud delete failed:", error);
        showToast("Inspection could not be deleted from Supabase.");
      }
      return;
    }

    var allHistory = getAllStoredHistory();
    var nextAll = allHistory.filter(function (item) {
      return item.id !== id;
    });

    if (!saveAllStoredHistory(nextAll)) {
      return;
    }

    setHistory(
      nextAll.filter(function (item) {
        return getHistoryOwnerId(item) === currentInspectorId;
      })
    );

    showToast(
      "Inspection removed."
    );
  }

  async function clearHistory() {
    if (!history.length) {
      return;
    }

    var confirmed =
      window.confirm(
        "Delete all saved inspection history?"
      );

    if (!confirmed) {
      return;
    }

    if (supabaseReady && supabaseUserUid) {
      try {
        await clearCloudHistory(supabaseUserUid);
        setHistory([]);
        showToast("Your Supabase inspection history was cleared.");
      } catch (error) {
        console.error("MetroCheck cloud history clear failed:", error);
        showToast("Inspection history could not be cleared from Supabase.");
      }
      return;
    }

    var allHistory = getAllStoredHistory();
    var remaining = allHistory.filter(function (item) {
      return getHistoryOwnerId(item) !== currentInspectorId;
    });

    if (!saveAllStoredHistory(remaining)) {
      return;
    }

    setHistory([]);

    showToast(
      "Your inspection history was cleared."
    );
  }

  function generatePDF() {
    var doc = new jsPDF();

    var margin = 16;
    var y = 18;

    /*
     * PHASE 3 FIX:
     * Use the inspection's saved timestamp instead of
     * generating today's date/time when an old inspection
     * is reopened.
     */
    var reportDate =
      new Date(
        inspectionTimestamp || Date.now()
      );

    function ensureSpace(required) {
      if (y + required > 275) {
        doc.addPage();
        y = 20;
      }
    }

    function addWrappedText(
      text,
      x,
      width,
      lineHeight
    ) {
      var lines =
        doc.splitTextToSize(
          String(text || ""),
          width
        );

      doc.text(
        lines,
        x,
        y
      );

      y +=
        lines.length *
        lineHeight;

      return lines;
    }

    doc.setFontSize(22);
    doc.setFont(
      "helvetica",
      "bold"
    );

    doc.text(
      "METROCHECK",
      margin,
      y
    );

    y += 8;

    doc.setFontSize(10);
    doc.setFont(
      "helvetica",
      "normal"
    );

    doc.text(
      "Packaged Commodity Legal Metrology Compliance Report",
      margin,
      y
    );

    y += 12;

    doc.setFontSize(11);

    doc.text(
      "Inspection ID: " +
        inspectionId,
      margin,
      y
    );

    y += 7;

    doc.text(
      "Date: " +
        formatDate(reportDate),
      margin,
      y
    );

    y += 7;

    doc.text(
      "Time: " +
        formatTime(reportDate),
      margin,
      y
    );

    y += 12;

    doc.setFont(
      "helvetica",
      "bold"
    );

    doc.text(
      "Inspection Summary",
      margin,
      y
    );

    doc.setFont(
      "helvetica",
      "normal"
    );

    y += 8;

    doc.text(
      "Commodity: " +
        (fields.productName ||
          "Not identified"),
      margin,
      y
    );

    y += 7;

    doc.text(
      "Compliance Score: " +
        score +
        "%",
      margin,
      y
    );

    y += 7;

    doc.text(
      "Automated Screening Status: " +
        status,
      margin,
      y
    );

    y += 7;

    doc.text(
      "Inspector Decision: " +
        (decision ||
          "Pending verification"),
      margin,
      y
    );

    y += 12;

    doc.setFont(
      "helvetica",
      "bold"
    );

    doc.text(
      "Inspector Details",
      margin,
      y
    );

    doc.setFont(
      "helvetica",
      "normal"
    );

    y += 8;

    doc.text(
      "Inspector Name: " +
        (inspector.name ||
          "Not provided"),
      margin,
      y
    );

    y += 7;

    doc.text(
      "Inspector ID: " +
        (inspector.id ||
          "Not provided"),
      margin,
      y
    );

    y += 12;

    doc.setFont(
      "helvetica",
      "bold"
    );

    doc.text(
      "Declaration Analysis",
      margin,
      y
    );

    doc.setFont(
      "helvetica",
      "normal"
    );

    y += 8;

    if (!results.length) {
      ensureSpace(25);

      doc.text(
        "No compliance checks have been activated for this inspection yet.",
        margin,
        y
      );

      y += 12;
    }

    results.forEach(
      function (
        rule,
        index
      ) {
        ensureSpace(35);

        doc.setFont(
          "helvetica",
          "bold"
        );

        doc.text(
          String(index + 1) +
            ". " +
            rule.title,
          margin,
          y
        );

        y += 6;

        doc.setFont(
          "helvetica",
          "normal"
        );

        doc.text(
          "Status: " +
            rule.status,
          margin + 4,
          y
        );

        y += 6;

        var lines =
          doc.splitTextToSize(
            rule.message,
            170
          );

        doc.text(
          lines,
          margin + 4,
          y
        );

        y +=
          lines.length *
            5 +
          5;
      }
    );

    ensureSpace(45);

    doc.setFont(
      "helvetica",
      "bold"
    );

    doc.text(
      "Physical Verification",
      margin,
      y
    );

    doc.setFont(
      "helvetica",
      "normal"
    );

    y += 8;

    doc.text(
      "Declared quantity: " +
        (fields.netQuantity ||
          "Not identified"),
      margin,
      y
    );

    y += 7;

    doc.text(
      "Measured quantity: " +
        (physicalQuantity
          ? physicalQuantity +
            " " +
            physicalUnit
          : "Not entered"),
      margin,
      y
    );

    y += 7;

    doc.text(
      "Quantity verification: " +
        quantityVerification.status,
      margin,
      y
    );

    y += 7;

    if (
      quantityVerification.message
    ) {
      var quantityLines =
        doc.splitTextToSize(
          quantityVerification.message,
          170
        );

      doc.text(
        quantityLines,
        margin,
        y
      );

      y +=
        quantityLines.length *
        5;
    }

    y += 8;

    ensureSpace(45);

    doc.setFont(
      "helvetica",
      "bold"
    );

    doc.text(
      "Declaration Values",
      margin,
      y
    );

    doc.setFont(
      "helvetica",
      "normal"
    );

    y += 8;

    FIELD_CONFIG.forEach(
      function (item) {
        var key = item[0];
        var label = item[1];

        var value =
          fields[key] ||
          "Not identified";

        ensureSpace(12);

        var valueLines =
          doc.splitTextToSize(
            label +
              ": " +
              value,
            175
          );

        doc.text(
          valueLines,
          margin,
          y
        );

        y +=
          valueLines.length *
          5 +
          2;
      }
    );

    if (notes) {
      ensureSpace(45);

      doc.setFont(
        "helvetica",
        "bold"
      );

      doc.text(
        "Inspector Notes",
        margin,
        y
      );

      y += 7;

      doc.setFont(
        "helvetica",
        "normal"
      );

      addWrappedText(
        notes,
        margin,
        175,
        5
      );

      y += 5;
    }

    if (evidence.length) {
      ensureSpace(
        20 +
          evidence.length *
            7
      );

      doc.setFont(
        "helvetica",
        "bold"
      );

      doc.text(
        "Evidence Files",
        margin,
        y
      );

      y += 7;

      doc.setFont(
        "helvetica",
        "normal"
      );

      evidence.forEach(
        function (item) {
          ensureSpace(10);

          doc.text(
            "• " +
              item.name,
            margin,
            y
          );

          y += 6;
        }
      );
    }

    ensureSpace(35);

    doc.setFontSize(8);
    doc.setFont(
      "helvetica",
      "italic"
    );

    var footerText =
      "MetroCheck is a prototype decision-support system. Automated screening assists inspection but does not replace inspector verification. Final enforcement decisions require applicable Legal Metrology rules, commodity-specific requirements, tolerances and competent authority verification.";

    var footerLines =
      doc.splitTextToSize(
        footerText,
        175
      );

    doc.text(
      footerLines,
      margin,
      y
    );

    doc.save(
      inspectionId +
        "-MetroCheck-Report.pdf"
    );

    showToast(
      "PDF report generated."
    );
  }

  if (authInitializing) {
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "24px",
          background: darkMode ? "#0b1220" : "#f4f7fb",
          color: darkMode ? "#f8fafc" : "#172033",
          fontFamily: "inherit",
          fontWeight: 700,
        }}
      >
        Restoring secure MetroCheck session…
      </div>
    );
  }

  if (!authenticatedInspectorId) {
    return (
      <InspectorAuthPage
        darkMode={darkMode}
        onToggleDarkMode={function () {
          setDarkMode(function (previous) {
            return !previous;
          });
        }}
        onRegister={registerInspector}
        onLogin={loginInspector}
        onDemoLogin={demoLogin}
        toast={toast}
        cloudReady={supabaseReady}
        cloudError={supabaseConfigError}
      />
    );
  }

  return (
    <div className="app-shell">
      {/* Native mobile camera inputs. Kept mounted so iOS/Android can
          open the camera directly from the user's tap. */}
      <input
        ref={frontCameraInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        style={{
          position: "fixed",
          left: "-10000px",
          top: "-10000px",
          width: "1px",
          height: "1px",
          opacity: 0,
          pointerEvents: "none",
        }}
        onChange={function (event) {
          var file =
            event.target.files && event.target.files[0];

          if (file) {
            handleImage(file, "front");
          }

          event.target.value = "";
        }}
      />

      <input
        ref={backCameraInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        style={{
          position: "fixed",
          left: "-10000px",
          top: "-10000px",
          width: "1px",
          height: "1px",
          opacity: 0,
          pointerEvents: "none",
        }}
        onChange={function (event) {
          var file =
            event.target.files && event.target.files[0];

          if (file) {
            handleImage(file, "back");
          }

          event.target.value = "";
        }}
      />
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <span>MC</span>
          </div>

          <div>
            <div className="brand-name">
              METROCHECK
            </div>

            <div className="brand-subtitle">
              LEGAL METROLOGY AI
            </div>
          </div>
        </div>

        <div className="sidebar-section">
          <div className="sidebar-label">
            WORKSPACE
          </div>

          <button
            className={
              "nav-item " +
              (page ===
              "dashboard"
                ? "active"
                : "")
            }
            onClick={function () {
              navigate(
                "dashboard"
              );
            }}
          >
            <Icon name="grid" />
            <span>
              Dashboard
            </span>
          </button>

          <button
            className={
              "nav-item " +
              (page === "scanner"
                ? "active"
                : "")
            }
            onClick={function () {
              navigate(
                "scanner"
              );
            }}
          >
            <Icon name="scan" />
            <span>
              New Inspection
            </span>
          </button>

          <button
            className={
              "nav-item " +
              (page === "history"
                ? "active"
                : "")
            }
            onClick={function () {
              navigate(
                "history"
              );
            }}
          >
            <Icon name="history" />
            <span>
              Inspection History
            </span>

            {history.length > 0 && (
              <span className="nav-count">
                {history.length}
              </span>
            )}
          </button>
        </div>

        <div className="sidebar-section">
          <div className="sidebar-label">
            SYSTEM
          </div>

          <button
            className={
              "nav-item " +
              (page === "about"
                ? "active"
                : "")
            }
            onClick={function () {
              navigate("about");
            }}
          >
            <Icon name="info" />
            <span>
              About MetroCheck
            </span>
          </button>
        </div>

        <div className="sidebar-bottom">
          <div className="system-card">
            <div className="system-card-icon">
              <Icon
                name="shield"
                size={22}
              />
            </div>

            <div>
              <strong>
                Inspection Engine
              </strong>

              <span>
                Operational
              </span>
            </div>

            <span className="online-dot" />
          </div>

          <button
            className="theme-button"
            onClick={function () {
              setDarkMode(
                function (previous) {
                  return !previous;
                }
              );
            }}
          >
            <Icon
              name={
                darkMode
                  ? "sun"
                  : "moon"
              }
            />

            <span>
              {darkMode
                ? "Light Mode"
                : "Dark Mode"}
            </span>
          </button>

          <div className="profile-mini">
            <div className="avatar">
              I
            </div>

            <div>
              <strong>
                {inspector.name || "Inspector"}
              </strong>

              <span>
                {inspector.id || "Not verified"}
              </span>
            </div>
          </div>
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div className="topbar-left">
            <div className="breadcrumb">
              <span>
                MetroCheck
              </span>

              <span className="breadcrumb-separator">
                /
              </span>

              <strong>
                {page ===
                "dashboard"
                  ? "Dashboard"
                  : page ===
                    "scanner"
                  ? "New Inspection"
                  : page ===
                    "history"
                  ? "Inspection History"
                  : "About"}
              </strong>
            </div>
          </div>

          <div className="topbar-right">
            <div className="secure-status">
              <span className="online-dot" />
              System Online
            </div>

            <button
              type="button"
              className="icon-button"
              title="Settings"
              aria-label="Open MetroCheck settings"
              onClick={function () {
                openSettings("settings");
              }}
            >
              <Icon
                name="settings"
                size={19}
              />
            </button>

            <button
              type="button"
              className="top-avatar"
              title="Inspector profile"
              aria-label="Open inspector profile"
              onClick={function () {
                openSettings("profile");
              }}
              style={{
                border: "none",
                cursor: "pointer",
                font: "inherit",
                padding: 0,
              }}
            >
              I
            </button>
          </div>
        </header>

        {page ===
          "dashboard" && (
          <DashboardPage
            history={history}
            onNewInspection={
              startNewInspection
            }
            onOpenHistory={
              function () {
                navigate(
                  "history"
                );
              }
            }
            onOpenInspection={
              loadInspection
            }
          />
        )}

        {page === "scanner" && (
          <ScannerPage
            inspectionId={
              inspectionId
            }
            imagePreview={
              imagePreview
            }
            imageFile={
              imageFile
            }
            packageImages={
              packageImages
            }
            selectedImageSide={
              selectedImageSide
            }
            scanState={
              scanState
            }
            scanProgress={
              scanProgress
            }
            ocrConfidence={
              ocrConfidence
            }
            extractionConfidence={
              extractionConfidence
            }
            fieldSources={
              fieldSources
            }
            intelligence={
              intelligence
            }
            environmentReadiness={
              environmentReadiness
            }
            ocrText={
              ocrText
            }
            fields={
              fields
            }
            results={
              results
            }
            score={
              score
            }
            status={
              status
            }
            passedCount={
              passedCount
            }
            failedCount={
              failedCount
            }
            physicalQuantity={
              physicalQuantity
            }
            physicalUnit={
              physicalUnit
            }
            quantityVerification={
              quantityVerification
            }
            evidence={
              evidence
            }
            decision={
              decision
            }
            notes={
              notes
            }
            inspector={
              inspector
            }
            cameraOpen={
              cameraOpen
            }
            cameraError={
              cameraError
            }
            cameraReady={
              cameraReady
            }
            videoRef={
              videoRef
            }
            onImage={
              handleImage
            }
            onSelectImageSide={
              setSelectedImageSide
            }
            onScan={
              runOCR
            }
            onField={
              updateField
            }
            onPhysicalQuantity={
              setPhysicalQuantity
            }
            onPhysicalUnit={
              setPhysicalUnit
            }
            onEvidence={
              handleEvidence
            }
            onRemoveEvidence={
              removeEvidence
            }
            onDecision={
              setDecision
            }
            onNotes={
              setNotes
            }
            onInspector={
              updateInspector
            }
            onSave={
              saveInspection
            }
            onPDF={
              generatePDF
            }
            onReset={
              resetInspection
            }
            onOpenCamera={
              openCamera
            }
            onCameraFile={
              handleCameraFile
            }
            onCloseCamera={
              closeCamera
            }
            onCapturePhoto={
              capturePhoto
            }
          />
        )}

        {page === "history" && (
          <HistoryPage
            history={
              filteredHistory
            }
            allHistory={
              history
            }
            search={
              historySearch
            }
            filter={
              historyFilter
            }
            onSearch={
              setHistorySearch
            }
            onFilter={
              setHistoryFilter
            }
            onOpen={
              loadInspection
            }
            onDelete={
              deleteInspection
            }
            onClear={
              clearHistory
            }
            onNew={
              startNewInspection
            }
          />
        )}

        {page === "about" && (
          <AboutPage />
        )}
      </main>

      {settingsOpen && (
        <SettingsModal
          view={settingsView}
          darkMode={darkMode}
          inspector={inspector}
          environmentReadiness={
            environmentReadiness
          }
          onClose={closeSettings}
          onToggleDarkMode={function () {
            setDarkMode(function (previous) {
              return !previous;
            });
          }}
          onLogout={logoutInspector}
        />
      )}

      {toast && (
        <div className="toast">
          <div className="toast-icon">
            <Icon
              name="check"
              size={16}
            />
          </div>

          <span>
            {toast}
          </span>
        </div>
      )}
    </div>
  );
}

function DashboardPage(props) {
  var history = props.history;

  var compliant =
    history.filter(function (item) {
      return item.status === "COMPLIANT";
    }).length;

  var nonCompliant =
    history.filter(function (item) {
      return item.status === "NON-COMPLIANT";
    }).length;

  var review =
    history.filter(function (item) {
      return item.status === "REVIEW REQUIRED";
    }).length;

  var recent =
    history.slice(0, 5);

  /*
   * PHASE 3 ANALYTICS
   */
  var averageScore =
    history.length > 0
      ? Math.round(
          history.reduce(
            function (total, item) {
              return (
                total +
                Number(item.score || 0)
              );
            },
            0
          ) / history.length
        )
      : 0;

  var passRate =
    history.length > 0
      ? Math.round(
          (compliant / history.length) *
            100
        )
      : 0;

  var attentionCount =
    nonCompliant + review;

  return (
    <div className="page">
      <section className="hero">
        <div>
          <div className="eyebrow">
            LEGAL METROLOGY •
            INSPECTION WORKSPACE
          </div>

          <h1>
            Inspect smarter.
            <br />
            <span>
              Decide with evidence.
            </span>
          </h1>

          <p>
            Scan packaged
            commodity labels,
            identify mandatory
            declarations, analyze
            compliance
            requirements and
            create an
            inspection-ready
            report.
          </p>

          <div className="hero-actions">
            <button
              className="primary-button large"
              onClick={
                props.onNewInspection
              }
            >
              <Icon
                name="scan"
                size={21}
              />

              Start New
              Inspection

              <Icon
                name="arrow"
                size={19}
              />
            </button>

            <button
              className="secondary-button large"
              onClick={
                props.onOpenHistory
              }
            >
              <Icon
                name="history"
                size={19}
              />

              View History
            </button>
          </div>
        </div>

        <div className="hero-visual">
          <div className="scanner-orbit orbit-one" />
          <div className="scanner-orbit orbit-two" />

          <div className="scanner-core">
            <div className="core-line" />

            <Icon
              name="shield"
              size={38}
            />

            <strong>
              METRO
            </strong>

            <span>
              CHECK
            </span>
          </div>

          <div className="floating-chip chip-one">
            OCR
          </div>

          <div className="floating-chip chip-two">
            RULE ENGINE
          </div>

          <div className="floating-chip chip-three">
            REPORT
          </div>
        </div>
      </section>

      <section className="section-heading">
        <div>
          <span className="eyebrow">
            OVERVIEW
          </span>

          <h2>
            Inspection intelligence
          </h2>
        </div>

        <span className="section-date">
          {formatDate()}
        </span>
      </section>

      <div className="stat-grid">
        <StatCard
          label="Total Inspections"
          value={
            history.length
          }
          caption="Saved in this browser"
          icon="file"
          tone="blue"
        />

        <StatCard
          label="Compliant"
          value={
            compliant
          }
          caption="Passed all checks"
          icon="check"
          tone="green"
        />

        <StatCard
          label="Non-Compliant"
          value={
            nonCompliant
          }
          caption="Violations identified"
          icon="warning"
          tone="red"
        />

        <StatCard
          label="Review Required"
          value={
            review
          }
          caption="Needs inspector review"
          icon="search"
          tone="amber"
        />
      </div>

      {/* PHASE 3 ANALYTICS PANEL */}
      <section
        className="panel"
        style={{
          marginTop: "14px",
        }}
      >
        <div className="panel-header">
          <div>
            <span className="panel-kicker">
              PERFORMANCE
            </span>

            <h3>
              Inspection performance
            </h3>
          </div>

          <span className="section-date">
            {history.length
              ? "Based on saved inspections"
              : "Awaiting inspection data"}
          </span>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns:
              "repeat(3, minmax(0, 1fr))",
            gap: "12px",
          }}
        >
          <AnalyticsMetric
            label="Average Score"
            value={
              history.length
                ? averageScore + "%"
                : "—"
            }
            caption={
              history.length
                ? "Across all saved inspections"
                : "Complete inspections to calculate"
            }
          />

          <AnalyticsMetric
            label="Pass Rate"
            value={
              history.length
                ? passRate + "%"
                : "—"
            }
            caption={
              history.length
                ? "Inspections marked compliant"
                : "No inspection outcomes yet"
            }
          />

          <AnalyticsMetric
            label="Needs Attention"
            value={
              history.length
                ? attentionCount
                : "—"
            }
            caption={
              history.length
                ? "Non-compliant + review required"
                : "No attention items yet"
            }
          />
        </div>
      </section>

      <div className="dashboard-grid">
        <section className="panel recent-panel">
          <div className="panel-header">
            <div>
              <span className="panel-kicker">
                ACTIVITY
              </span>

              <h3>
                Recent inspections
              </h3>
            </div>

            <button
              className="text-button"
              onClick={
                props.onOpenHistory
              }
            >
              View all{" "}
              <Icon
                name="arrow"
                size={16}
              />
            </button>
          </div>

          {recent.length ===
          0 ? (
            <EmptyState
              icon="scan"
              title="No inspections yet"
              text="Start your first packaged commodity inspection to see activity here."
              action={
                <button
                  className="secondary-button"
                  onClick={
                    props.onNewInspection
                  }
                >
                  Start Inspection
                </button>
              }
            />
          ) : (
            <div className="activity-list">
              {recent.map(
                function (
                  item
                ) {
                  return (
                    <button
                      className="activity-row"
                      key={
                        item.id
                      }
                      onClick={function () {
                        props.onOpenInspection(
                          item
                        );
                      }}
                    >
                      <div className="activity-icon">
                        <Icon
                          name="scan"
                          size={18}
                        />
                      </div>

                      <div className="activity-main">
                        <strong>
                          {
                            item.productName
                          }
                        </strong>

                        <span>
                          {
                            item.id
                          }{" "}
                          •{" "}
                          {
                            item.date
                          }{" "}
                          •{" "}
                          {
                            item.time
                          }
                        </span>
                      </div>

                      <div className="activity-score">
                        <strong>
                          {
                            item.score
                          }%
                        </strong>

                        <span>
                          score
                        </span>
                      </div>

                      <StatusBadge
                        status={
                          item.status
                        }
                      />

                      <Icon
                        name="arrow"
                        size={17}
                      />
                    </button>
                  );
                }
              )}
            </div>
          )}
        </section>

        <section className="panel methodology-panel">
          <div className="panel-header">
            <div>
              <span className="panel-kicker">
                WORKFLOW
              </span>

              <h3>
                How MetroCheck works
              </h3>
            </div>
          </div>

          <div className="workflow-list">
            <WorkflowStep
              number="01"
              title="Capture"
              text="Take a live camera photo or upload a package image."
            />

            <WorkflowStep
              number="02"
              title="Extract"
              text="OCR identifies visible declarations and values."
            />

            <WorkflowStep
              number="03"
              title="Analyze"
              text="The rule engine maps extracted data to compliance checks."
            />

            <WorkflowStep
              number="04"
              title="Verify"
              text="Inspector reviews evidence and physical quantity."
            />

            <WorkflowStep
              number="05"
              title="Report"
              text="Generate a structured inspection report."
            />
          </div>
        </section>
      </div>

      <section className="info-strip">
        <div className="info-strip-icon">
          <Icon
            name="shield"
            size={22}
          />
        </div>

        <div>
          <strong>
            Inspector-first design
          </strong>

          <p>
            OCR and automated
            checks assist the
            inspector. Physical
            measurements remain
            inspector-entered and
            final enforcement
            decisions remain
            subject to verification.
          </p>
        </div>
      </section>
    </div>
  );
}

function AnalyticsMetric(props) {
  return (
    <div
      style={{
        padding: "16px",
        borderRadius: "14px",
        border:
          "1px solid var(--border, rgba(100,120,150,0.18))",
        background:
          "var(--surface-soft, rgba(100,120,150,0.04))",
      }}
    >
      <div
        style={{
          fontSize: "12px",
          fontWeight: 700,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          opacity: 0.7,
          marginBottom: "8px",
        }}
      >
        {props.label}
      </div>

      <div
        style={{
          fontSize: "28px",
          fontWeight: 800,
          lineHeight: 1.1,
          marginBottom: "6px",
        }}
      >
        {props.value}
      </div>

      <div
        style={{
          fontSize: "12px",
          lineHeight: 1.4,
          opacity: 0.65,
        }}
      >
        {props.caption}
      </div>
    </div>
  );
}

function StatCard(props) {
  return (
    <div
      className={
        "stat-card stat-" +
        props.tone
      }
    >
      <div className="stat-top">
        <div className="stat-icon">
          <Icon
            name={props.icon}
            size={19}
          />
        </div>

        <span>
          {props.label}
        </span>
      </div>

      <div className="stat-value">
        {props.value}
      </div>

      <div className="stat-caption">
        {props.caption}
      </div>
    </div>
  );
}

function WorkflowStep(props) {
  return (
    <div className="workflow-step">
      <div className="workflow-number">
        {props.number}
      </div>

      <div>
        <strong>
          {props.title}
        </strong>

        <p>
          {props.text}
        </p>
      </div>
    </div>
  );
}

function ScannerPage(props) {
  var [showOCR, setShowOCR] =
    useState(false);

  return (
    <div className="page scanner-page">
      <PageTitle
        eyebrow="INSPECTION WORKSPACE"
        title="New packaged commodity inspection"
        text={
          "Inspection ID " +
          props.inspectionId +
          " • Capture both package panels, analyze and verify."
        }
        action={
          <button
            className="secondary-button"
            onClick={
              props.onReset
            }
          >
            <Icon
              name="refresh"
              size={17}
            />

            Reset
          </button>
        }
      />

      <div className="inspection-progress">
        <ProgressStep
          number="01"
          title="Capture"
          active={
            !!props.imagePreview
          }
        />

        <div className="progress-line" />

        <ProgressStep
          number="02"
          title="OCR & Extract"
          active={
            props.scanState ===
            "complete"
          }
        />

        <div className="progress-line" />

        <ProgressStep
          number="03"
          title="Compliance"
          active={
            props.results.length >
            0
          }
        />

        <div className="progress-line" />

        <ProgressStep
          number="04"
          title="Verify & Report"
          active={
            !!props.decision
          }
        />
      </div>

      <section className="scanner-layout">
        <div className="scanner-left">
          <div className="panel scanner-panel">
            <div className="panel-header">
              <div>
                <span className="panel-kicker">
                  STEP 01
                </span>

                <h3>
                  Product / label image
                </h3>
              </div>

              {props.scanState ===
                "complete" && (
                <StatusBadge
                  status="SCAN COMPLETE"
                />
              )}
            </div>

            <div
              style={{
                display: "grid",
                gridTemplateColumns:
                  "repeat(auto-fit, minmax(240px, 1fr))",
                gap: "14px",
                marginBottom: "16px",
              }}
            >
              {["front", "back"].map(
                function (side) {
                  var image =
                    props.packageImages &&
                    props.packageImages[side];

                  return (
                    <div
                      key={side}
                      style={{
                        border:
                          "1px solid var(--border, rgba(100,120,150,0.18))",
                        borderRadius: "16px",
                        padding: "12px",
                        background:
                          "var(--surface-soft, rgba(100,120,150,0.04))",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: "8px",
                          marginBottom: "10px",
                        }}
                      >
                        <strong
                          style={{
                            fontSize: "13px",
                            textTransform:
                              "uppercase",
                            letterSpacing:
                              "0.06em",
                          }}
                        >
                          {side} side
                        </strong>

                        <span
                          style={{
                            fontSize: "11px",
                            fontWeight: 700,
                            opacity: 0.65,
                          }}
                        >
                          {image
                            ? "Captured"
                            : "Required"}
                        </span>
                      </div>

                      {image ? (
                        <div
                          style={{
                            position:
                              "relative",
                            borderRadius: "12px",
                            overflow:
                              "hidden",
                            background:
                              "#050b14",
                          }}
                        >
                          <img
                            src={image.preview}
                            alt={
                              side +
                              " side of packaged commodity"
                            }
                            className="product-image"
                            style={{
                              width: "100%",
                              minHeight:
                                "170px",
                              objectFit:
                                "contain",
                            }}
                          />

                          <label
                            className="change-image"
                            style={{
                              position:
                                "absolute",
                              right: "10px",
                              bottom: "10px",
                            }}
                          >
                            <input
                              type="file"
                              accept="image/*"
                              onChange={function (
                                event
                              ) {
                                props.onImage(
                                  event.target
                                    .files &&
                                    event.target
                                      .files[0],
                                  side
                                );
                              }}
                            />
                            Change
                          </label>
                        </div>
                      ) : (
                        <label
                          className="upload-zone"
                          style={{
                            minHeight:
                              "190px",
                            display: "flex",
                            flexDirection:
                              "column",
                            justifyContent:
                              "center",
                            padding:
                              "18px",
                            cursor:
                              "pointer",
                          }}
                          onClick={function () {
                            props.onSelectImageSide(
                              side
                            );
                          }}
                        >
                          <input
                            type="file"
                            accept="image/*"
                            onChange={function (
                              event
                            ) {
                              props.onImage(
                                event.target
                                  .files &&
                                  event.target
                                    .files[0],
                                side
                              );
                            }}
                          />

                          <div className="upload-icon">
                            <Icon
                              name="upload"
                              size={24}
                            />
                          </div>

                          <strong
                            style={{
                              marginTop:
                                "6px",
                            }}
                          >
                            Upload {side} photo
                          </strong>

                          <small
                            style={{
                              marginTop:
                                "5px",
                              textAlign:
                                "center",
                            }}
                          >
                            Clear, straight-on
                            photo recommended
                          </small>
                        </label>
                      )}

                      <button
                        className={
                          "secondary-button"
                        }
                        type="button"
                        style={{
                          width: "100%",
                          marginTop: "10px",
                        }}
                        onClick={function () {
                          props.onSelectImageSide(
                            side
                          );
                          props.onOpenCamera(side);
                        }}
                      >
                        <Icon
                          name="camera"
                          size={17}
                        />
                        Capture {side}
                      </button>
                    </div>
                  );
                }
              )}
            </div>

            <div
              style={{
                padding: "12px 14px",
                borderRadius: "12px",
                background:
                  "rgba(37, 99, 235, 0.07)",
                border:
                  "1px solid rgba(37, 99, 235, 0.16)",
                fontSize: "12px",
                lineHeight: 1.5,
                marginBottom: "14px",
              }}
            >
              <strong>
                Capture both package panels
              </strong>
              <div style={{ marginTop: "3px" }}>
                MetroCheck combines the front and back
                images into one inspection. If a declaration
                appears on another panel, the inspector can
                add that evidence separately.
              </div>
            </div>

            <div
              className="scan-action-row"
              style={{
                justifyContent: "flex-end",
              }}
            >
              <div className="file-meta">
                <div className="file-meta-icon">
                  <Icon
                    name="file"
                    size={18}
                  />
                </div>

                <div>
                  <strong>
                    {props.packageImages &&
                    props.packageImages.front &&
                    props.packageImages.back
                      ? "Front + back images ready"
                      : props.packageImages &&
                        (props.packageImages.front ||
                          props.packageImages.back)
                      ? "1 package panel ready"
                      : "No package image selected"}
                  </strong>

                  <span>
                    {props.packageImages &&
                    props.packageImages.front &&
                    props.packageImages.back
                      ? "Ready for combined OCR analysis"
                      : "Add front and back for the most complete inspection"}
                  </span>
                </div>
              </div>

              <button
                className="primary-button"
                onClick={
                  props.onScan
                }
                disabled={
                  props.scanState ===
                  "scanning" ||
                  !(
                    props.packageImages &&
                    (
                      props.packageImages.front ||
                      props.packageImages.back
                    )
                  )
                }
              >
                <Icon
                  name={
                    props.scanState ===
                    "scanning"
                      ? "refresh"
                      : "scan"
                  }
                  size={18}
                />

                {props.scanState ===
                "scanning"
                  ? "Scanning..."
                  : props.scanState ===
                    "complete"
                  ? "Scan Again"
                  : "Analyze Package"}
              </button>
            </div>

            {props.scanState ===
              "scanning" && (
              <div className="scan-progress-box">
                <div className="scan-progress-top">
                  <span>
                    Analyzing package images
                  </span>

                  <strong>
                    {
                      props.scanProgress
                    }
                    %
                  </strong>
                </div>

                <div className="progress-track">
                  <div
                    className="progress-fill"
                    style={{
                      width:
                        String(
                          props.scanProgress
                        ) +
                        "%",
                    }}
                  />
                </div>

                <span>
                  OCR is identifying
                  text and declaration
                  patterns. This may
                  take a few moments.
                </span>
              </div>
            )}

            {props.scanState ===
              "error" && (
              <div className="error-box">
                <div className="error-icon">
                  <Icon
                    name="warning"
                    size={18}
                  />
                </div>

                <div>
                  <strong>
                    OCR processing failed
                  </strong>

                  <p>
                    You can continue
                    by entering the
                    declaration fields
                    manually.
                  </p>
                </div>
              </div>
            )}
          </div>

          {props.imagePreview && (
            <div className="panel">
              <div className="panel-header">
                <div>
                  <span className="panel-kicker">PHASE 4 INTELLIGENCE</span>
                  <h3>Scan confidence & readiness</h3>
                </div>
                <StatusBadge
                  status={
                    props.ocrConfidence === null
                      ? "PENDING"
                      : props.ocrConfidence >= 75
                      ? "HIGH CONFIDENCE"
                      : props.ocrConfidence >= 60
                      ? "MEDIUM CONFIDENCE"
                      : "LOW CONFIDENCE"
                  }
                />
              </div>

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
                  gap: "12px",
                }}
              >
                <div className="mini-stat">
                  <strong>{props.ocrConfidence === null ? "—" : props.ocrConfidence + "%"}</strong>
                  <span>OCR confidence</span>
                </div>
                <div className="mini-stat">
                  <strong>{props.extractionConfidence + "%"}</strong>
                  <span>Extraction readiness</span>
                </div>
                <div className="mini-stat">
                  <strong>{props.intelligence.readiness + "%"}</strong>
                  <span>Inspection readiness</span>
                </div>
              </div>

              {props.ocrConfidence !== null && props.ocrConfidence < 60 && (
                <div className="inspector-note" style={{ marginTop: "12px" }}>
                  <Icon name="warning" size={18} />
                  <span>
                    <strong>Low-confidence scan</strong>
                    <br />
                    Retake the image before relying heavily on OCR output.
                  </span>
                </div>
              )}
            </div>
          )}

          <div className="panel">
            <div className="panel-header">
              <div>
                <span className="panel-kicker">
                  STEP 02
                </span>

                <h3>
                  Extracted declarations
                </h3>
              </div>

              <button
                className="text-button"
                onClick={function () {
                  setShowOCR(
                    function (
                      previous
                    ) {
                      return !previous;
                    }
                  );
                }}
              >
                {showOCR
                  ? "Hide OCR text"
                  : "View raw OCR"}
              </button>
            </div>

            {showOCR && (
              <div className="ocr-box">
                {props.ocrText ||
                  "No OCR text available yet."}
              </div>
            )}

            <div className="field-grid">
              {FIELD_CONFIG.map(
                function (
                  item
                ) {
                  var key =
                    item[0];

                  var label =
                    item[1];

                  var placeholder =
                    item[2];

                  return (
                    <div
                      className="field"
                      key={key}
                    >
                      <label>
                        <span>{label}</span>
                        {props.fieldSources && props.fieldSources[key] ? (
                          <span
                            style={{
                              marginLeft: "8px",
                              fontSize: "11px",
                              opacity: 0.7,
                            }}
                          >
                            {props.fieldSources[key] === "OCR" ? "OCR" : "MANUAL"}
                          </span>
                        ) : null}
                      </label>

                      <input
                        value={
                          props
                            .fields[
                            key
                          ]
                        }
                        onChange={function (
                          event
                        ) {
                          props.onField(
                            key,
                            event
                              .target
                              .value
                          );
                        }}
                        placeholder={
                          placeholder
                        }
                      />
                    </div>
                  );
                }
              )}
            </div>
          </div>

          <div className="panel">
            <div className="panel-header">
              <div>
                <span className="panel-kicker">
                  STEP 03
                </span>

                <h3>
                  Compliance analysis
                </h3>
              </div>

              {props.results
                .length >
                0 && (
                <StatusBadge
                  status={
                    props.status
                  }
                />
              )}
            </div>

            {props.results
              .length ===
            0 ? (
              <EmptyState
                icon="search"
                title="Compliance analysis waiting"
                text="Run OCR or enter declaration information to activate the rule analysis."
              />
            ) : (
              <>
                <div className="compliance-summary">
                  <div className="score-ring">
                    <div>
                      <strong>
                        {
                          props.score
                        }
                      </strong>

                      <span>
                        %
                      </span>
                    </div>
                  </div>

                  <div className="compliance-summary-copy">
                    <span className="panel-kicker">
                      AUTOMATED SCREENING
                    </span>

                    <h3>
                      {
                        props.status
                      }
                    </h3>

                    <p>
                      {
                        props.passedCount
                      }{" "}
                      checks passed
                      and{" "}
                      {
                        props.failedCount
                      }{" "}
                      checks require
                      attention.
                    </p>
                  </div>

                  <div className="mini-stat">
                    <strong>
                      {
                        props.passedCount
                      }
                    </strong>

                    <span>
                      Passed
                    </span>
                  </div>

                  <div className="mini-stat danger">
                    <strong>
                      {
                        props.failedCount
                      }
                    </strong>

                    <span>
                      Failed
                    </span>
                  </div>
                </div>

                <div className="rule-list">
                  {props.results.map(
                    function (
                      rule
                    ) {
                      return (
                        <RuleCard
                          rule={
                            rule
                          }
                          key={
                            rule.id
                          }
                        />
                      );
                    }
                  )}
                </div>
              </>
            )}
          </div>
        </div>

        <div className="scanner-right">
          <div className="panel sticky-panel">
            <div className="panel-header">
              <div>
                <span className="panel-kicker">
                  LIVE RESULT
                </span>

                <h3>
                  Inspection status
                </h3>
              </div>
            </div>

            <div
              className={
                "result-hero result-" +
                props.status
                  .toLowerCase()
                  .replace(
                    / /g,
                    "-"
                  )
              }
            >
              <div className="result-icon">
                <Icon
                  name={
                    props.status ===
                    "COMPLIANT"
                      ? "check"
                      : props.status ===
                        "NON-COMPLIANT"
                      ? "warning"
                      : "search"
                  }
                  size={25}
                />
              </div>

              <div>
                <span>
                  Current assessment
                </span>

                <strong>
                  {
                    props.status
                  }
                </strong>
              </div>
            </div>

            <div className="result-score-row">
              <div>
                <span>
                  Compliance score
                </span>

                <strong>
                  {
                    props.score
                  }%
                </strong>
              </div>

              <div className="score-bar">
                <div
                  style={{
                    width:
                      String(
                        props.score
                      ) +
                      "%",
                  }}
                  className="score-bar-fill"
                />
              </div>
            </div>

            <div className="summary-list">
              <SummaryLine
                label="Rules evaluated"
                value={
                  props.results
                    .length
                }
              />

              <SummaryLine
                label="Passed"
                value={
                  props.passedCount
                }
                good
              />

              <SummaryLine
                label="Attention required"
                value={
                  props.failedCount
                }
                bad
              />

              <SummaryLine
                label="Evidence files"
                value={
                  props.evidence
                    .length
                }
              />
            </div>

            <div
              style={{
                marginTop: "14px",
                padding: "10px 12px",
                borderRadius: "10px",
                border: "1px solid currentColor",
                fontSize: "12px",
              }}
            >
              <strong>Demo environment</strong>
              <div style={{ marginTop: "5px", opacity: 0.8 }}>
                Camera security: {props.environmentReadiness.secure ? "Ready" : "Use HTTPS / localhost"}
                <br />
                Data storage: {props.environmentReadiness.cloud ? "Supabase Cloud" : props.environmentReadiness.storage ? "Browser LocalStorage" : "Unavailable"}
              </div>
            </div>
          </div>

          {props.results.length > 0 && (
            <div className="panel">
              <div className="panel-header">
                <div>
                  <span className="panel-kicker">DECISION SUPPORT</span>
                  <h3>Recommended inspector actions</h3>
                </div>
                {props.intelligence.priority && (
                  <StatusBadge status="PRIORITY REVIEW" />
                )}
              </div>

              {props.intelligence.priority && (
                <div
                  style={{
                    padding: "12px",
                    borderRadius: "10px",
                    border: "1px solid currentColor",
                    marginBottom: "12px",
                  }}
                >
                  <strong>Priority: {props.intelligence.priority.title}</strong>
                  <p style={{ margin: "6px 0 0" }}>
                    {props.intelligence.priority.message}
                  </p>
                </div>
              )}

              <div style={{ display: "grid", gap: "8px" }}>
                {props.intelligence.actions.map(function (action, index) {
                  return (
                    <div
                      key={action + index}
                      style={{ display: "flex", gap: "9px", alignItems: "flex-start" }}
                    >
                      <Icon name="arrow" size={16} />
                      <span>{action}</span>
                    </div>
                  );
                })}
              </div>

              {props.intelligence.missing.length > 0 && (
                <div style={{ marginTop: "12px", fontSize: "13px", opacity: 0.8 }}>
                  Missing / unconfirmed fields: {props.intelligence.missing.join(", ")}.
                </div>
              )}
            </div>
          )}

          <div className="panel">
            <div className="panel-header">
              <div>
                <span className="panel-kicker">
                  PHYSICAL CHECK
                </span>

                <h3>
                  Inspector verification
                </h3>
              </div>
            </div>

            <div className="inspector-note">
              <Icon
                name="info"
                size={18}
              />

              <span>
                Physical quantity must
                be entered by the
                inspector. It is not
                estimated from the image.
              </span>
            </div>

            <div
              className="field"
              style={{
                marginBottom:
                  "14px",
              }}
            >
              <label>
                Inspector Name
              </label>

              <input
                value={
                  props.inspector
                    .name
                }
                onChange={function (
                  event
                ) {
                  props.onInspector(
                    "name",
                    event.target
                      .value
                  );
                }}
                placeholder="Enter inspector name"
              />
            </div>

            <div
              className="field"
              style={{
                marginBottom:
                  "14px",
              }}
            >
              <label>
                Inspector ID
              </label>

              <input
                value={
                  props.inspector
                    .id
                }
                onChange={function (
                  event
                ) {
                  props.onInspector(
                    "id",
                    event.target
                      .value
                  );
                }}
                placeholder="Enter inspector / employee ID"
              />
            </div>

            <div className="field">
              <label>
                Measured quantity
              </label>

              <div className="input-with-suffix">
                <input
                  type="number"
                  min="0"
                  step="0.001"
                  value={
                    props.physicalQuantity
                  }
                  onChange={function (
                    event
                  ) {
                    props.onPhysicalQuantity(
                      event.target
                        .value
                    );
                  }}
                  placeholder="Enter measured quantity"
                />

                <span>
                  actual
                </span>
              </div>
            </div>

            <div
              className="field"
              style={{
                marginTop:
                  "14px",
              }}
            >
              <label>
                Measurement unit
              </label>

              <select
                value={
                  props.physicalUnit
                }
                onChange={function (
                  event
                ) {
                  props.onPhysicalUnit(
                    event.target
                      .value
                  );
                }}
              >
                <option value="g">
                  grams (g)
                </option>

                <option value="kg">
                  kilograms (kg)
                </option>

                <option value="mg">
                  milligrams (mg)
                </option>

                <option value="ml">
                  millilitres (ml)
                </option>

                <option value="l">
                  litres (L)
                </option>
              </select>
            </div>

            {props.quantityVerification
              .available && (
              <div
                className="inspector-note"
                style={{
                  marginTop:
                    "14px",
                }}
              >
                <Icon
                  name={
                    props
                      .quantityVerification
                      .status ===
                    "PASS"
                      ? "check"
                      : "warning"
                  }
                  size={18}
                />

                <span>
                  <strong>
                    Quantity check:{" "}
                    {
                      props
                        .quantityVerification
                        .status
                    }
                  </strong>

                  <br />

                  {
                    props
                      .quantityVerification
                      .message
                  }
                </span>
              </div>
            )}

            <div className="decision-block">
              <label>
                Inspector decision
              </label>

              <div className="decision-options">
                {[
                  [
                    "COMPLIANT",
                    "check",
                  ],
                  [
                    "NON-COMPLIANT",
                    "warning",
                  ],
                  [
                    "REVIEW REQUIRED",
                    "search",
                  ],
                ].map(
                  function (
                    item
                  ) {
                    return (
                      <button
                        key={
                          item[0]
                        }
                        className={
                          "decision-option " +
                          (props.decision ===
                          item[0]
                            ? "selected"
                            : "")
                        }
                        onClick={function () {
                          props.onDecision(
                            item[0]
                          );
                        }}
                      >
                        <Icon
                          name={
                            item[1]
                          }
                          size={16}
                        />

                        {
                          item[0]
                        }
                      </button>
                    );
                  }
                )}
              </div>
            </div>

            <div className="field">
              <label>
                Inspector notes
              </label>

              <textarea
                value={
                  props.notes
                }
                onChange={function (
                  event
                ) {
                  props.onNotes(
                    event.target
                      .value
                  );
                }}
                placeholder="Record observations, verification notes or additional findings..."
                rows={5}
              />
            </div>
          </div>

          <div className="panel">
            <div className="panel-header">
              <div>
                <span className="panel-kicker">
                  EVIDENCE
                </span>

                <h3>
                  Supporting files
                </h3>
              </div>
            </div>

            <label className="evidence-upload">
              <input
                type="file"
                multiple
                accept="image/*,.pdf"
                onChange={function (
                  event
                ) {
                  props.onEvidence(
                    event.target
                      .files
                  );

                  event.target.value =
                    "";
                }}
              />

              <Icon
                name="upload"
                size={20}
              />

              <span>
                <strong>
                  Add evidence
                </strong>

                <small>
                  Photos or PDF documents
                </small>
              </span>
            </label>

            {props.evidence
              .length >
              0 && (
              <div className="evidence-list">
                {props.evidence.map(
                  function (
                    item
                  ) {
                    return (
                      <div
                        className="evidence-item"
                        key={
                          item.id
                        }
                      >
                        <div className="evidence-file-icon">
                          <Icon
                            name="file"
                            size={16}
                          />
                        </div>

                        <div>
                          <strong>
                            {
                              item.name
                            }
                          </strong>

                          <span>
                            {(
                              item.size /
                              1024
                            ).toFixed(
                              0
                            )}{" "}
                            KB
                          </span>
                        </div>

                        <button
                          onClick={function () {
                            props.onRemoveEvidence(
                              item.id
                            );
                          }}
                          title="Remove evidence"
                        >
                          <Icon
                            name="close"
                            size={16}
                          />
                        </button>
                      </div>
                    );
                  }
                )}
              </div>
            )}
          </div>

          <div className="final-actions">
            <button
              className="secondary-button"
              onClick={
                props.onPDF
              }
            >
              <Icon
                name="download"
                size={18}
              />

              Generate PDF
            </button>

            <button
              className="primary-button large"
              onClick={
                props.onSave
              }
            >
              <Icon
                name="check"
                size={18}
              />

              Save Inspection

              <Icon
                name="arrow"
                size={18}
              />
            </button>
          </div>
        </div>
      </section>

      {props.cameraOpen && (
        <CameraModal
          onClose={props.onCloseCamera}
          onCaptureFile={props.onCameraFile}
          selectedSide={props.selectedImageSide}
        />
      )}
    </div>
  );
}

function CameraModal(props) {
  var videoRef = useRef(null);
  var streamRef = useRef(null);
  var nativeCaptureRef = useRef(null);
  var mountedRef = useRef(true);

  var [cameraStatus, setCameraStatus] = useState("starting");
  var [cameraMessage, setCameraMessage] = useState("");
  var [captureBusy, setCaptureBusy] = useState(false);

  var selectedSide = props.selectedSide === "back" ? "back" : "front";

  function stopLocalCamera() {
    var stream = streamRef.current;

    if (stream) {
      try {
        stream.getTracks().forEach(function (track) {
          track.stop();
        });
      } catch (error) {
        console.warn("MetroCheck camera cleanup warning:", error);
      }

      streamRef.current = null;
    }

    var video = videoRef.current;
    if (video) {
      try {
        video.pause();
      } catch (error) {
        console.warn(error);
      }

      try {
        video.srcObject = null;
      } catch (error) {
        console.warn(error);
      }
    }
  }

  useEffect(function () {
    mountedRef.current = true;
    var cancelled = false;
    var readyTimer = null;

    function finishWithFallback(message) {
      if (cancelled || !mountedRef.current) {
        return;
      }

      stopLocalCamera();
      setCameraMessage(message || "Live camera is unavailable in this browser.");
      setCameraStatus("fallback");
    }

    function waitForVideo(video) {
      return new Promise(function (resolve, reject) {
        var settled = false;
        var timeout = window.setTimeout(function () {
          if (settled) {
            return;
          }

          settled = true;
          cleanup();
          reject(new Error("Camera preview timed out"));
        }, 8000);

        function cleanup() {
          window.clearTimeout(timeout);
          video.removeEventListener("loadedmetadata", onReady);
          video.removeEventListener("canplay", onReady);
          video.removeEventListener("playing", onReady);
          video.removeEventListener("error", onError);
        }

        function onReady() {
          if (settled) {
            return;
          }

          if (video.videoWidth > 0 && video.videoHeight > 0) {
            settled = true;
            cleanup();
            resolve();
          }
        }

        function onError() {
          if (settled) {
            return;
          }

          settled = true;
          cleanup();
          reject(new Error("Camera preview could not be displayed"));
        }

        video.addEventListener("loadedmetadata", onReady);
        video.addEventListener("canplay", onReady);
        video.addEventListener("playing", onReady);
        video.addEventListener("error", onError);

        onReady();
      });
    }

    async function startCamera() {
      setCameraStatus("starting");
      setCameraMessage("");

      /*
       * getUserMedia is only available in a secure context on normal web
       * pages. localhost is treated as secure. A phone opening the Vite app
       * through http://192.168.x.x:5173 is NOT secure, so we immediately use
       * the native camera input instead of showing a black/blank preview.
       */
      if (
        !window.isSecureContext ||
        !navigator.mediaDevices ||
        typeof navigator.mediaDevices.getUserMedia !== "function"
      ) {
        finishWithFallback(
          window.isSecureContext
            ? "Live camera is not supported by this browser. Use the camera button below."
            : "Live browser camera requires HTTPS or localhost. Use the device camera button below, or open MetroCheck through HTTPS/localhost."
        );
        return;
      }

      var stream = null;

      try {
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: {
              facingMode: { ideal: "environment" },
              width: { ideal: 1280 },
              height: { ideal: 720 },
            },
            audio: false,
          });
        } catch (preferredError) {
          console.warn(
            "MetroCheck preferred camera constraints failed; retrying default camera:",
            preferredError
          );

          stream = await navigator.mediaDevices.getUserMedia({
            video: true,
            audio: false,
          });
        }

        if (cancelled || !mountedRef.current) {
          if (stream) {
            stream.getTracks().forEach(function (track) {
              track.stop();
            });
          }
          return;
        }

        if (!stream || !stream.getVideoTracks || stream.getVideoTracks().length === 0) {
          throw new Error("No video track was returned by the browser");
        }

        streamRef.current = stream;

        var video = videoRef.current;
        if (!video) {
          throw new Error("Camera preview element is not available");
        }

        video.srcObject = stream;
        video.muted = true;
        video.playsInline = true;
        video.autoplay = true;

        try {
          var playResult = video.play();
          if (playResult && typeof playResult.catch === "function") {
            playResult.catch(function (playError) {
              /*
               * Some Safari versions reject the first programmatic play even
               * for a muted inline video. Do not block camera initialization
               * on that promise; metadata/canplay can still make the stream
               * usable and waitForVideo has its own timeout.
               */
              console.warn("MetroCheck camera play warning:", playError);
            });
          }
        } catch (playError) {
          console.warn("MetroCheck camera play warning:", playError);
        }

        await waitForVideo(video);

        if (cancelled || !mountedRef.current) {
          return;
        }

        setCameraStatus("ready");
        setCameraMessage("");
      } catch (error) {
        console.error("MetroCheck live camera failed:", error);

        var errorName = error && error.name ? String(error.name) : "";
        var message =
          errorName === "NotAllowedError" || errorName === "SecurityError"
            ? "Camera permission is blocked. Allow camera access for this site, then reopen Capture. You can also use the device camera button below."
            : errorName === "NotFoundError" || errorName === "DevicesNotFoundError"
            ? "No usable camera was found on this device."
            : errorName === "NotReadableError" || errorName === "TrackStartError"
            ? "The camera is busy in another app or browser tab. Close the other camera app and try again."
            : "The live camera could not start. Use the device camera button below.";

        finishWithFallback(message);
      }
    }

    /*
     * Defer one animation frame so the <video> element is definitely mounted
     * before getUserMedia resolves and the stream is attached to it.
     */
    readyTimer = window.requestAnimationFrame(function () {
      startCamera();
    });

    return function () {
      cancelled = true;
      mountedRef.current = false;

      if (readyTimer !== null) {
        window.cancelAnimationFrame(readyTimer);
      }

      stopLocalCamera();
    };
  }, [selectedSide]);

  function createCapturedFile(blob) {
    var fileName =
      "MetroCheck-" +
      selectedSide +
      "-Capture-" +
      Date.now() +
      ".jpg";

    try {
      if (typeof File === "function") {
        return new File([blob], fileName, {
          type: "image/jpeg",
          lastModified: Date.now(),
        });
      }
    } catch (error) {
      console.warn("File constructor unavailable; using Blob:", error);
    }

    blob.name = fileName;
    return blob;
  }

  function canvasToJpegBlob(canvas) {
    return new Promise(function (resolve, reject) {
      if (typeof canvas.toBlob === "function") {
        canvas.toBlob(
          function (blob) {
            if (blob) {
              resolve(blob);
            } else {
              reject(new Error("Camera capture returned an empty image"));
            }
          },
          "image/jpeg",
          0.9
        );
        return;
      }

      try {
        var dataUrl = canvas.toDataURL("image/jpeg", 0.9);
        var pieces = dataUrl.split(",");
        var binary = atob(pieces[1] || "");
        var bytes = new Uint8Array(binary.length);

        for (var index = 0; index < binary.length; index += 1) {
          bytes[index] = binary.charCodeAt(index);
        }

        resolve(
          new Blob([bytes], {
            type: "image/jpeg",
          })
        );
      } catch (error) {
        reject(error);
      }
    });
  }

  async function captureLivePhoto() {
    if (captureBusy || cameraStatus !== "ready") {
      return;
    }

    var video = videoRef.current;
    if (!video || !video.videoWidth || !video.videoHeight) {
      setCameraMessage("The camera is still starting. Wait a moment and try again.");
      return;
    }

    setCaptureBusy(true);

    try {
      var sourceWidth = video.videoWidth;
      var sourceHeight = video.videoHeight;

      /*
       * Cap the captured frame to 1920 px on its longest edge. This keeps OCR
       * detail while preventing large mobile canvases from exhausting memory.
       */
      var longestEdge = Math.max(sourceWidth, sourceHeight);
      var scale = longestEdge > 1920 ? 1920 / longestEdge : 1;
      var targetWidth = Math.max(1, Math.round(sourceWidth * scale));
      var targetHeight = Math.max(1, Math.round(sourceHeight * scale));

      var canvas = document.createElement("canvas");
      canvas.width = targetWidth;
      canvas.height = targetHeight;

      var context = canvas.getContext("2d", {
        alpha: false,
      });

      if (!context) {
        throw new Error("Canvas is unavailable");
      }

      context.drawImage(video, 0, 0, targetWidth, targetHeight);

      var blob = await canvasToJpegBlob(canvas);
      var file = createCapturedFile(blob);

      stopLocalCamera();

      if (typeof props.onCaptureFile === "function") {
        props.onCaptureFile(file, selectedSide);
      }
    } catch (error) {
      console.error("MetroCheck photo capture failed:", error);
      setCameraMessage(
        "The photo could not be captured. Try the device camera button below."
      );
      setCameraStatus("fallback");
      stopLocalCamera();
    } finally {
      if (mountedRef.current) {
        setCaptureBusy(false);
      }
    }
  }

  function handleNativeCapture(event) {
    var file = event.target.files && event.target.files[0];
    event.target.value = "";

    if (!file) {
      return;
    }

    stopLocalCamera();

    if (typeof props.onCaptureFile === "function") {
      props.onCaptureFile(file, selectedSide);
    }
  }

  function closeModal() {
    stopLocalCamera();
    if (typeof props.onClose === "function") {
      props.onClose();
    }
  }

  var isStarting = cameraStatus === "starting";
  var isReady = cameraStatus === "ready";
  var useFallback = cameraStatus === "fallback";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={"Capture " + selectedSide + " package photo"}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        background: "rgba(4, 12, 28, 0.92)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "14px",
        overflowY: "auto",
      }}
    >
      <div
        style={{
          width: "min(900px, 100%)",
          maxHeight: "94vh",
          overflowY: "auto",
          background: "var(--surface, #ffffff)",
          color: "var(--text, #172033)",
          borderRadius: "20px",
          padding: "18px",
          boxShadow: "0 25px 80px rgba(0,0,0,0.35)",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: "14px",
            gap: "12px",
          }}
        >
          <div>
            <span className="panel-kicker">LIVE CAMERA</span>
            <h2 style={{ margin: "4px 0 0", fontSize: "20px" }}>
              Capture {selectedSide === "front" ? "front" : "back"} side
            </h2>
          </div>

          <button
            type="button"
            className="icon-button"
            onClick={closeModal}
            title="Close camera"
          >
            <Icon name="close" size={22} />
          </button>
        </div>

        <div
          style={{
            position: "relative",
            background: "#050b14",
            borderRadius: "16px",
            overflow: "hidden",
            minHeight: "280px",
            height: "min(60vh, 560px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            disablePictureInPicture
            style={{
              display: isReady || isStarting ? "block" : "none",
              width: "100%",
              height: "100%",
              objectFit: "contain",
              background: "#050b14",
            }}
          />

          {isStarting && (
            <div
              style={{
                position: "absolute",
                inset: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexDirection: "column",
                gap: "10px",
                color: "white",
                padding: "20px",
                textAlign: "center",
              }}
            >
              <Icon name="camera" size={34} />
              <strong>Starting camera…</strong>
              <span style={{ fontSize: "12px", opacity: 0.75 }}>
                Allow camera permission when your browser asks.
              </span>
            </div>
          )}

          {isReady && (
            <>
              <div
                style={{
                  position: "absolute",
                  inset: "10%",
                  border: "2px solid rgba(255,255,255,0.86)",
                  borderRadius: "12px",
                  pointerEvents: "none",
                }}
              />
              <div
                style={{
                  position: "absolute",
                  left: "12px",
                  right: "12px",
                  bottom: "16px",
                  textAlign: "center",
                  color: "white",
                  fontSize: "12px",
                  textShadow: "0 2px 8px rgba(0,0,0,0.9)",
                  pointerEvents: "none",
                }}
              >
                Keep the complete {selectedSide} label inside the frame
              </div>
            </>
          )}

          {useFallback && (
            <div
              style={{
                color: "white",
                textAlign: "center",
                padding: "24px",
                maxWidth: "620px",
              }}
            >
              <Icon name="camera" size={42} />
              <strong style={{ display: "block", marginTop: "12px" }}>
                Live preview unavailable
              </strong>
              <p
                style={{
                  margin: "8px 0 0",
                  opacity: 0.8,
                  fontSize: "12px",
                  lineHeight: 1.6,
                }}
              >
                {cameraMessage}
              </p>
            </div>
          )}
        </div>

        {cameraMessage && !useFallback && (
          <div
            style={{
              marginTop: "12px",
              padding: "10px 12px",
              borderRadius: "10px",
              background: "rgba(217,145,0,0.10)",
              border: "1px solid rgba(217,145,0,0.24)",
              fontSize: "12px",
              lineHeight: 1.5,
            }}
          >
            {cameraMessage}
          </div>
        )}

        <div
          style={{
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
            gap: "10px",
            marginTop: "16px",
            flexWrap: "wrap",
          }}
        >
          <button
            type="button"
            className="secondary-button"
            onClick={closeModal}
          >
            <Icon name="close" size={18} />
            Cancel
          </button>

          {isReady && (
            <button
              type="button"
              className="primary-button large"
              disabled={captureBusy}
              onClick={captureLivePhoto}
            >
              <Icon name="camera" size={20} />
              {captureBusy
                ? "Capturing…"
                : "Capture " +
                  (selectedSide === "front" ? "Front" : "Back") +
                  " Photo"}
            </button>
          )}

          {(useFallback || isStarting) && (
            <label
              className="primary-button large"
              style={{ cursor: "pointer" }}
            >
              <input
                ref={nativeCaptureRef}
                type="file"
                accept="image/*"
                capture="environment"
                onChange={handleNativeCapture}
                style={{ display: "none" }}
              />
              <Icon name="camera" size={20} />
              Open Device Camera
            </label>
          )}
        </div>

        <div
          style={{
            marginTop: "12px",
            color: "var(--muted, #718096)",
            fontSize: "10px",
            lineHeight: 1.55,
            textAlign: "center",
          }}
        >
          Laptop live camera: use localhost or HTTPS and allow browser camera
          permission. Phone over a local HTTP address: use Open Device Camera.
        </div>
      </div>
    </div>
  );
}

function PageTitle(props) {
  return (
    <div className="page-title">
      <div>
        <span className="eyebrow">
          {props.eyebrow}
        </span>

        <h1>
          {props.title}
        </h1>

        <p>
          {props.text}
        </p>
      </div>

      {props.action}
    </div>
  );
}

function ProgressStep(props) {
  return (
    <div
      className={
        "progress-step " +
        (props.active
          ? "active"
          : "")
      }
    >
      <span>
        {props.number}
      </span>

      <strong>
        {props.title}
      </strong>
    </div>
  );
}

function RuleCard(props) {
  var rule = props.rule;

  return (
    <div
      className={
        "rule-card rule-" +
        rule.status.toLowerCase()
      }
    >
      <div className="rule-status-icon">
        <Icon
          name={
            rule.status === "PASS"
              ? "check"
              : rule.status === "NOT APPLICABLE"
              ? "info"
              : "warning"
          }
          size={17}
        />
      </div>

      <div className="rule-content">
        <div className="rule-title-row">
          <div>
            <strong>
              {rule.title}
            </strong>

            <span>
              {rule.short}
            </span>
          </div>

          <div className="rule-right">
            <span
              className={
                "severity severity-" +
                rule.severity.toLowerCase()
              }
            >
              {
                rule.severity
              }
            </span>

            {rule.status === "FAIL" && rule.severity === "HIGH" && (
              <span
                style={{
                  fontSize: "10px",
                  fontWeight: 700,
                  letterSpacing: "0.05em",
                }}
              >
                PRIORITY
              </span>
            )}

            <StatusBadge
              status={
                rule.status
              }
            />
          </div>
        </div>

        <p>
          {rule.message}
        </p>

        <small
          style={{
            display: "block",
            marginTop: "6px",
            opacity: 0.75,
          }}
        >
          Legal basis: {rule.reference}
          {" • "}
          {rule.description}
        </small>
      </div>
    </div>
  );
}

function SummaryLine(props) {
  return (
    <div className="summary-line">
      <span>
        {props.label}
      </span>

      <strong
        className={
          props.good
            ? "good-text"
            : props.bad
            ? "bad-text"
            : ""
        }
      >
        {props.value}
      </strong>
    </div>
  );
}

function HistoryPage(props) {
  var total =
    props.allHistory.length;

  var compliant =
    props.allHistory.filter(
      function (item) {
        return (
          item.status ===
          "COMPLIANT"
        );
      }
    ).length;

  var nonCompliant =
    props.allHistory.filter(
      function (item) {
        return (
          item.status ===
          "NON-COMPLIANT"
        );
      }
    ).length;

  var review =
    props.allHistory.filter(
      function (item) {
        return (
          item.status ===
          "REVIEW REQUIRED"
        );
      }
    ).length;

  return (
    <div
      className="page"
      style={{
        paddingTop: "10px",
      }}
    >
      <PageTitle
        eyebrow="RECORDS"
        title="Inspection history"
        text="Review previously saved inspections, compliance outcomes and evidence."
        action={
          <button
            className="primary-button"
            onClick={
              props.onNew
            }
          >
            <Icon
              name="plus"
              size={18}
            />

            New Inspection
          </button>
        }
      />

      {/* PHASE 3 HISTORY SUMMARY */}
      {total > 0 && (
        <section
          className="panel"
          style={{
            marginBottom: "14px",
          }}
        >
          <div
            style={{
              display: "grid",
              gridTemplateColumns:
                "repeat(4, minmax(0, 1fr))",
              gap: "10px",
            }}
          >
            <HistoryMetric
              label="Total"
              value={total}
            />

            <HistoryMetric
              label="Compliant"
              value={compliant}
            />

            <HistoryMetric
              label="Non-Compliant"
              value={nonCompliant}
            />

            <HistoryMetric
              label="Review"
              value={review}
            />
          </div>
        </section>
      )}

      <div className="history-toolbar">
        <div className="search-box">
          <Icon
            name="search"
            size={20}
          />

          <input
            value={
              props.search
            }
            onChange={function (
              event
            ) {
              props.onSearch(
                event.target
                  .value
              );
            }}
            placeholder="Search inspection ID, commodity or status..."
          />
        </div>

        <div className="filter-buttons">
          {[
            "ALL",
            "COMPLIANT",
            "NON-COMPLIANT",
            "REVIEW REQUIRED",
          ].map(
            function (
              item
            ) {
              return (
                <button
                  key={item}
                  className={
                    props.filter ===
                    item
                      ? "active"
                      : ""
                  }
                  onClick={function () {
                    props.onFilter(
                      item
                    );
                  }}
                >
                  {item ===
                  "ALL"
                    ? "All"
                    : item}
                </button>
              );
            }
          )}
        </div>

        {props.allHistory
          .length >
          0 && (
          <button
            className="danger-text-button"
            onClick={
              props.onClear
            }
          >
            <Icon
              name="trash"
              size={16}
            />

            Clear
          </button>
        )}
      </div>

      <section className="panel history-panel">
        {props.history.length ===
        0 ? (
          <EmptyState
            icon="history"
            title={
              props.allHistory
                .length
                ? "No matching inspections"
                : "No inspection history"
            }
            text={
              props.allHistory
                .length
                ? "Try another search or filter."
                : "Saved inspection reports will appear here."
            }
            action={
              !props.allHistory
                .length && (
                <button
                  className="primary-button"
                  onClick={
                    props.onNew
                  }
                >
                  Start First
                  Inspection
                </button>
              )
            }
          />
        ) : (
          <div className="history-table">
            <div className="history-head">
              <span>
                INSPECTION
              </span>

              <span>
                COMMODITY
              </span>

              <span>
                DATE
              </span>

              <span>
                SCORE
              </span>

              <span>
                STATUS
              </span>

              <span />
            </div>

            {props.history.map(
              function (
                item
              ) {
                return (
                  <div
                    className="history-row"
                    key={
                      item.id
                    }
                  >
                    <div className="history-id">
                      <div className="table-icon">
                        <Icon
                          name="file"
                          size={17}
                        />
                      </div>

                      <div>
                        <strong>
                          {
                            item.id
                          }
                        </strong>

                        <span>
                          {
                            item.time
                          }
                        </span>
                      </div>
                    </div>

                    <strong className="commodity-name">
                      {
                        item.productName
                      }
                    </strong>

                    <span>
                      {item.date}
                    </span>

                    <div className="table-score">
                      <strong>
                        {
                          item.score
                        }%
                      </strong>

                      <div>
                        <span
                          style={{
                            width:
                              String(
                                item.score
                              ) +
                              "%",
                          }}
                        />
                      </div>
                    </div>

                    <StatusBadge
                      status={
                        item.status
                      }
                    />

                    <div className="row-actions">
                      <button
                        onClick={function () {
                          props.onOpen(
                            item
                          );
                        }}
                      >
                        Open{" "}
                        <Icon
                          name="arrow"
                          size={15}
                        />
                      </button>

                      <button
                        className="delete-button"
                        onClick={function () {
                          props.onDelete(
                            item.id
                          );
                        }}
                        title="Delete inspection"
                      >
                        <Icon
                          name="trash"
                          size={15}
                        />
                      </button>
                    </div>
                  </div>
                );
              }
            )}
          </div>
        )}
      </section>
    </div>
  );
}

function HistoryMetric(props) {
  return (
    <div
      style={{
        padding: "12px 14px",
        borderRadius: "12px",
        background:
          "var(--surface-soft, rgba(100,120,150,0.04))",
        border:
          "1px solid var(--border, rgba(100,120,150,0.16))",
      }}
    >
      <div
        style={{
          fontSize: "11px",
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: "0.07em",
          opacity: 0.65,
        }}
      >
        {props.label}
      </div>

      <strong
        style={{
          display: "block",
          marginTop: "5px",
          fontSize: "22px",
        }}
      >
        {props.value}
      </strong>
    </div>
  );
}

function AboutCard(props) {
  return (
    <div className="panel about-card">
      <div className="about-card-icon">
        <Icon
          name={props.icon || "info"}
          size={24}
        />
      </div>

      <div>
        <h3>{props.title}</h3>
        <p>{props.text}</p>
      </div>
    </div>
  );
}

function AboutPage() {
  return (
    <div className="page">
      <PageTitle
        eyebrow="SYSTEM"
        title="About MetroCheck"
        text="A decision-support prototype for packaged commodity inspection under Legal Metrology requirements."
      />

      <div className="about-hero panel">
        <div className="about-mark">
          <div className="brand-mark large-mark">
            <span>
              MC
            </span>
          </div>
        </div>

        <div>
          <span className="eyebrow">
            METROCHECK
          </span>

          <h2>
            From package image
            to inspection
            decision.
          </h2>

          <p>
            MetroCheck combines
            camera capture,
            image-based text
            extraction, structured
            declaration analysis,
            rule-based compliance
            screening and inspector
            verification into a
            single inspection
            workflow.
          </p>
        </div>
      </div>

      <div className="about-grid">
        <AboutCard
          icon="camera"
          title="Camera Capture"
          text="Inspectors can capture a package or label directly from the browser camera."
        />

        <AboutCard
          icon="scan"
          title="OCR & Computer Vision"
          text="Package images are processed to identify visible text and declaration patterns."
        />

        <AboutCard
          icon="shield"
          title="Rule-Based Screening"
          text="Extracted information is evaluated against configurable compliance checks."
        />

        <AboutCard
          icon="user"
          title="Inspector Verification"
          text="Automated results support the inspector instead of replacing field verification."
        />

        <AboutCard
          icon="file"
          title="Evidence & Reports"
          text="Inspection records can be saved locally and exported as structured PDF reports."
        />
      </div>

      <section className="panel legal-panel">
        <div className="panel-header">
          <div>
            <span className="panel-kicker">
              IMPORTANT
            </span>

            <h3>
              Prototype limitation
            </h3>
          </div>
        </div>

        <p>
          MetroCheck is a
          demonstration
          decision-support system.
          Automated screening
          should not be treated as
          a legally binding
          determination. Applicable
          rules, exemptions,
          amendments,
          commodity-specific
          requirements, tolerances
          and final enforcement
          decisions require
          appropriate inspector and
          legal verification.
        </p>
      </section>
    </div>
  );
}

function InspectorAuthPage(props) {
  var darkMode = props.darkMode;
  var surface = darkMode ? "#111827" : "#ffffff";
  var text = darkMode ? "#f8fafc" : "#172033";
  var muted = darkMode ? "#aab4c4" : "#697586";
  var border = darkMode ? "#2d3748" : "#e2e8f0";
  var softBackground = darkMode ? "#172033" : "#f4f7fb";
  var inputBackground = darkMode ? "#182233" : "#f8fafc";

  var [mode, setMode] = useState("login");
  var [inspectorId, setInspectorId] = useState("");
  var [email, setEmail] = useState("");
  var [password, setPassword] = useState("");
  var [confirmPassword, setConfirmPassword] = useState("");

  function submitLogin(event) {
    event.preventDefault();
    props.onLogin(email, password);
  }

  function submitRegistration(event) {
    event.preventDefault();

    if (password !== confirmPassword) {
      return;
    }

    props.onRegister({
      id: inspectorId,
      email: email,
      password: password,
    });
  }

  var fieldStyle = {
    width: "100%",
    boxSizing: "border-box",
    padding: "13px 14px",
    borderRadius: "12px",
    border: "1px solid " + border,
    background: inputBackground,
    color: text,
    outline: "none",
    fontSize: "14px",
  };

  var primaryButtonStyle = {
    width: "100%",
    padding: "13px 16px",
    borderRadius: "12px",
    border: "none",
    background: "#2563eb",
    color: "#ffffff",
    cursor: "pointer",
    fontWeight: 800,
    fontSize: "14px",
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        background: darkMode ? "#0b1220" : "#f4f7fb",
        color: text,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "24px",
        boxSizing: "border-box",
      }}
    >
      <div
        style={{
          width: "min(980px, 100%)",
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
          gap: "18px",
        }}
      >
        <section
          style={{
            background: surface,
            border: "1px solid " + border,
            borderRadius: "22px",
            padding: "28px",
            boxShadow: "0 20px 60px rgba(0, 0, 0, 0.10)",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "14px",
              marginBottom: "24px",
            }}
          >
            <div>
              <div
                style={{
                  fontSize: "12px",
                  fontWeight: 900,
                  letterSpacing: "0.16em",
                  textTransform: "uppercase",
                  color: muted,
                }}
              >
                MetroCheck
              </div>
              <h1
                style={{
                  margin: "8px 0 0",
                  fontSize: "30px",
                  lineHeight: 1.1,
                }}
              >
                Inspector Portal
              </h1>
            </div>

            <button
              type="button"
              onClick={props.onToggleDarkMode}
              title="Toggle theme"
              style={{
                border: "1px solid " + border,
                borderRadius: "11px",
                background: softBackground,
                color: text,
                cursor: "pointer",
                padding: "10px 12px",
                fontWeight: 800,
              }}
            >
              {darkMode ? "☀" : "☾"}
            </button>
          </div>

          <div
            style={{
              padding: "14px 15px",
              borderRadius: "14px",
              background: softBackground,
              border: "1px solid " + border,
              marginBottom: "20px",
            }}
          >
            <strong style={{ display: "block", fontSize: "14px" }}>
              Government-registered access
            </strong>
            <p
              style={{
                margin: "6px 0 0",
                color: muted,
                fontSize: "12px",
                lineHeight: 1.55,
              }}
            >
              MetroCheck does not let inspectors create arbitrary identities.
              First-time registration verifies the inspector against the
              department registry before the account is activated.
            </p>
          </div>

          {!props.cloudReady && props.cloudError && (
            <div
              role="alert"
              style={{
                marginBottom: "16px",
                padding: "12px 14px",
                borderRadius: "12px",
                border: "1px solid #f0b429",
                background: darkMode ? "#3a2b0d" : "#fff8e1",
                color: darkMode ? "#fde68a" : "#8a5a00",
                fontSize: "12px",
                lineHeight: 1.55,
              }}
            >
              <strong style={{ display: "block", marginBottom: "4px" }}>
                Cloud connection needs attention
              </strong>
              {props.cloudError}
            </div>
          )}

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: "8px",
              marginBottom: "20px",
            }}
          >
            <button
              type="button"
              onClick={function () { setMode("login"); }}
              style={{
                padding: "11px",
                borderRadius: "11px",
                border: "1px solid " + border,
                background: mode === "login" ? "#2563eb" : softBackground,
                color: mode === "login" ? "#ffffff" : text,
                cursor: "pointer",
                fontWeight: 800,
              }}
            >
              Sign in
            </button>
            <button
              type="button"
              onClick={function () { setMode("register"); }}
              style={{
                padding: "11px",
                borderRadius: "11px",
                border: "1px solid " + border,
                background: mode === "register" ? "#2563eb" : softBackground,
                color: mode === "register" ? "#ffffff" : text,
                cursor: "pointer",
                fontWeight: 800,
              }}
            >
              First-time sign up
            </button>
          </div>

          {mode === "login" ? (
            <form onSubmit={submitLogin}>
              <label style={{ display: "block", marginBottom: "14px", fontSize: "13px", fontWeight: 800 }}>
                Official email
                <input
                  type="email"
                  value={email}
                  onChange={function (event) { setEmail(event.target.value); }}
                  placeholder="official@department.gov.in"
                  style={Object.assign({}, fieldStyle, { marginTop: "7px" })}
                  required
                />
              </label>

              <label style={{ display: "block", marginBottom: "16px", fontSize: "13px", fontWeight: 800 }}>
                Password
                <input
                  type="password"
                  value={password}
                  onChange={function (event) { setPassword(event.target.value); }}
                  placeholder="Enter your MetroCheck password"
                  style={Object.assign({}, fieldStyle, { marginTop: "7px" })}
                  required
                />
              </label>

              <button type="submit" style={primaryButtonStyle}>
                Sign in to MetroCheck
              </button>

              <button
                type="button"
                onClick={props.onDemoLogin}
                style={{
                  width: "100%",
                  padding: "12px 16px",
                  marginTop: "10px",
                  borderRadius: "12px",
                  border: "1px solid " + border,
                  background: softBackground,
                  color: text,
                  cursor: "pointer",
                  fontWeight: 800,
                  fontSize: "14px",
                }}
              >
                Enter Demo Inspector
              </button>

              <p
                style={{
                  margin: "10px 0 0",
                  color: muted,
                  fontSize: "11px",
                  lineHeight: 1.45,
                  textAlign: "center",
                }}
              >
                SIH demo access — no real government credentials required.
              </p>
            </form>
          ) : (
            <form onSubmit={submitRegistration}>
              <label style={{ display: "block", marginBottom: "14px", fontSize: "13px", fontWeight: 800 }}>
                Government Inspector ID
                <input
                  type="text"
                  value={inspectorId}
                  onChange={function (event) { setInspectorId(event.target.value); }}
                  placeholder="e.g. INS-001"
                  style={Object.assign({}, fieldStyle, { marginTop: "7px" })}
                  required
                />
              </label>

              <label style={{ display: "block", marginBottom: "14px", fontSize: "13px", fontWeight: 800 }}>
                Registered official email
                <input
                  type="email"
                  value={email}
                  onChange={function (event) { setEmail(event.target.value); }}
                  placeholder="Use the email registered with the department"
                  style={Object.assign({}, fieldStyle, { marginTop: "7px" })}
                  required
                />
              </label>

              <label style={{ display: "block", marginBottom: "14px", fontSize: "13px", fontWeight: 800 }}>
                Create password
                <input
                  type="password"
                  value={password}
                  onChange={function (event) { setPassword(event.target.value); }}
                  placeholder="At least 6 characters"
                  style={Object.assign({}, fieldStyle, { marginTop: "7px" })}
                  required
                />
              </label>

              <label style={{ display: "block", marginBottom: "16px", fontSize: "13px", fontWeight: 800 }}>
                Confirm password
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={function (event) { setConfirmPassword(event.target.value); }}
                  placeholder="Re-enter password"
                  style={Object.assign({}, fieldStyle, { marginTop: "7px" })}
                  required
                />
              </label>

              {confirmPassword && password !== confirmPassword && (
                <div style={{ color: "#dc2626", fontSize: "12px", marginBottom: "12px" }}>
                  Passwords do not match.
                </div>
              )}

              <button type="submit" style={primaryButtonStyle}>
                Verify & create account
              </button>
            </form>
          )}
        </section>

        <section
          style={{
            background: surface,
            border: "1px solid " + border,
            borderRadius: "22px",
            padding: "28px",
            boxShadow: "0 20px 60px rgba(0, 0, 0, 0.06)",
          }}
        >
          <div
            style={{
              fontSize: "11px",
              fontWeight: 900,
              letterSpacing: "0.14em",
              textTransform: "uppercase",
              color: muted,
              marginBottom: "10px",
            }}
          >
            How access works
          </div>

          <h2 style={{ margin: "0 0 18px", fontSize: "22px" }}>
            Registered first. Account second.
          </h2>

          <div style={{ display: "grid", gap: "12px" }}>
            {[
              ["01", "Department registration", "The inspector already exists in the government registry."],
              ["02", "Identity verification", "MetroCheck matches the submitted Inspector ID and registered official email."],
              ["03", "Account activation", "The verified inspector creates a MetroCheck login for future sign-ins."],
              ["04", "Private workspace", "Inspection history, reports and profile information are tied to that inspector ID."],
            ].map(function (item) {
              return (
                <div
                  key={item[0]}
                  style={{
                    display: "flex",
                    gap: "12px",
                    padding: "13px",
                    borderRadius: "13px",
                    background: softBackground,
                    border: "1px solid " + border,
                  }}
                >
                  <div style={{ fontWeight: 900, color: "#2563eb" }}>
                    {item[0]}
                  </div>
                  <div>
                    <strong style={{ display: "block", fontSize: "13px" }}>
                      {item[1]}
                    </strong>
                    <span style={{ display: "block", marginTop: "3px", color: muted, fontSize: "12px", lineHeight: 1.5 }}>
                      {item[2]}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>

          <div
            style={{
              marginTop: "18px",
              padding: "14px",
              borderRadius: "14px",
              border: "1px dashed " + border,
              color: muted,
              fontSize: "11px",
              lineHeight: 1.55,
            }}
          >
            SIH prototype note: the government registry is mocked locally for
            demonstration. A production deployment would verify identities
            against the department's authenticated backend and database.
          </div>

          <div
            style={{
              marginTop: "14px",
              padding: "14px",
              borderRadius: "14px",
              background: darkMode ? "#172033" : "#eff6ff",
              border: "1px solid " + border,
              fontSize: "12px",
              lineHeight: 1.5,
            }}
          >
            <strong>Demo registry IDs:</strong>
            <div style={{ marginTop: "6px", color: muted }}>
              INS-001 · inspector@demo.metrology.gov.in<br />
              INS-002 · priya.sharma@demo.metrology.gov.in<br />
              INS-003 · ravi.kumar@demo.metrology.gov.in
            </div>
          </div>
        </section>
      </div>

      {props.toast && (
        <div
          style={{
            position: "fixed",
            left: "50%",
            bottom: "22px",
            transform: "translateX(-50%)",
            padding: "11px 15px",
            borderRadius: "12px",
            background: darkMode ? "#1f2937" : "#172033",
            color: "#ffffff",
            boxShadow: "0 12px 35px rgba(0,0,0,0.2)",
            fontSize: "13px",
            fontWeight: 700,
            zIndex: 3000,
            maxWidth: "calc(100% - 32px)",
          }}
        >
          {props.toast}
        </div>
      )}
    </div>
  );
}

function SettingsModal(props) {
  var darkMode = props.darkMode;
  var inspector = props.inspector || {};
  var environmentReadiness =
    props.environmentReadiness || {
      secure: false,
      storage: false,
    };

  var surface = darkMode ? "#111827" : "#ffffff";
  var text = darkMode ? "#f8fafc" : "#172033";
  var muted = darkMode ? "#aab4c4" : "#697586";
  var border = darkMode ? "#2d3748" : "#e2e8f0";
  var softBackground = darkMode ? "#172033" : "#f4f7fb";

  function handleOverlayClick(event) {
    if (event.target === event.currentTarget) {
      props.onClose();
    }
  }

  return (
    <div
      role="presentation"
      onMouseDown={handleOverlayClick}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 2000,
        background: "rgba(5, 15, 30, 0.58)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "16px",
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="metrocheck-settings-title"
        onMouseDown={function (event) { event.stopPropagation(); }}
        style={{
          width: "min(620px, 100%)",
          maxHeight: "calc(100vh - 32px)",
          overflowY: "auto",
          background: surface,
          color: text,
          border: "1px solid " + border,
          borderRadius: "22px",
          boxShadow: "0 24px 70px rgba(0, 0, 0, 0.28)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "16px",
            padding: "20px 22px",
            borderBottom: "1px solid " + border,
          }}
        >
          <div>
            <div style={{ fontSize: "11px", fontWeight: 800, letterSpacing: "0.14em", textTransform: "uppercase", color: muted, marginBottom: "6px" }}>
              MetroCheck
            </div>
            <h2 id="metrocheck-settings-title" style={{ margin: 0, fontSize: "22px", lineHeight: 1.2 }}>
              {props.view === "profile" ? "Inspector Profile" : "Settings"}
            </h2>
          </div>

          <button
            type="button"
            aria-label="Close"
            title="Close"
            onClick={props.onClose}
            style={{
              width: "38px",
              height: "38px",
              borderRadius: "12px",
              border: "1px solid " + border,
              background: softBackground,
              color: text,
              cursor: "pointer",
              fontSize: "22px",
              lineHeight: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            ×
          </button>
        </div>

        <div style={{ padding: "20px 22px 22px" }}>
          {props.view === "profile" ? (
            <>
              <div
                style={{
                  padding: "18px",
                  borderRadius: "16px",
                  background: softBackground,
                  border: "1px solid " + border,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "14px", marginBottom: "16px" }}>
                  <div
                    style={{
                      width: "52px",
                      height: "52px",
                      borderRadius: "16px",
                      background: "#2563eb",
                      color: "#ffffff",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: "20px",
                      fontWeight: 900,
                    }}
                  >
                    {(inspector.name || "I").charAt(0).toUpperCase()}
                  </div>
                  <div>
                    <strong style={{ display: "block", fontSize: "17px" }}>
                      {inspector.name || "Inspector"}
                    </strong>
                    <span style={{ display: "block", marginTop: "3px", color: muted, fontSize: "12px" }}>
                      Verified government inspector
                    </span>
                  </div>
                </div>

                <div style={{ display: "grid", gap: "10px" }}>
                  <ProfileRow label="Inspector ID" value={inspector.id || "Not assigned"} />
                  <ProfileRow label="Official email" value={inspector.email || "Not registered"} />
                  <ProfileRow label="Department" value={inspector.department || "Legal Metrology Department"} />
                  <ProfileRow label="Office / jurisdiction" value={inspector.office || "Not specified"} />
                </div>
              </div>

              <p style={{ margin: "12px 0 0", color: muted, fontSize: "12px", lineHeight: 1.55 }}>
                These identity details come from the verified government registry record. They are not editable from the MetroCheck workspace.
              </p>

              <button
                type="button"
                onClick={props.onLogout}
                style={{
                  width: "100%",
                  marginTop: "18px",
                  padding: "12px 16px",
                  borderRadius: "12px",
                  border: "1px solid " + border,
                  background: softBackground,
                  color: text,
                  cursor: "pointer",
                  fontWeight: 800,
                }}
              >
                Sign out
              </button>
            </>
          ) : (
            <>
              <div
                style={{
                  padding: "16px",
                  borderRadius: "16px",
                  background: softBackground,
                  border: "1px solid " + border,
                  marginBottom: "16px",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "14px" }}>
                  <div>
                    <div style={{ fontSize: "15px", fontWeight: 800 }}>Appearance</div>
                    <div style={{ marginTop: "4px", color: muted, fontSize: "12px" }}>
                      Switch the MetroCheck workspace theme.
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={props.onToggleDarkMode}
                    style={{ border: "1px solid " + border, borderRadius: "11px", background: softBackground, color: text, cursor: "pointer", padding: "10px 13px", fontWeight: 800, fontSize: "12px" }}
                  >
                    {darkMode ? "☀ Light mode" : "☾ Dark mode"}
                  </button>
                </div>
              </div>

              <div
                style={{
                  padding: "16px",
                  borderRadius: "16px",
                  background: softBackground,
                  border: "1px solid " + border,
                }}
              >
                <div style={{ fontSize: "12px", fontWeight: 800, letterSpacing: "0.08em", textTransform: "uppercase", color: muted, marginBottom: "12px" }}>
                  System status
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "10px" }}>
                  <StatusBox label="Browser security" value={environmentReadiness.secure ? "Ready" : "Local browser mode"} />
                  <StatusBox label="Database" value={environmentReadiness.cloud ? "Supabase Cloud" : environmentReadiness.storage ? "LocalStorage fallback" : "Unavailable"} />
                  <StatusBox label="Account model" value="Government registry verification" />
                  <StatusBox label="History isolation" value="Inspector ID scoped" />
                </div>
              </div>

              <div style={{ marginTop: "16px", padding: "14px", borderRadius: "14px", border: "1px dashed " + border, color: muted, fontSize: "11px", lineHeight: 1.55 }}>
                Settings control the application environment only. Inspector identity and inspection history are managed through the verified Inspector Profile and account session.
              </div>
            </>
          )}
        </div>
      </section>
    </div>
  );
}

function ProfileRow(props) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        gap: "14px",
        padding: "11px 12px",
        borderRadius: "11px",
        background: "rgba(100,120,150,0.05)",
      }}
    >
      <span style={{ color: "inherit", fontSize: "12px", fontWeight: 700 }}>
        {props.label}
      </span>
      <span style={{ color: "inherit", fontSize: "12px", textAlign: "right" }}>
        {props.value}
      </span>
    </div>
  );
}

function StatusBox(props) {
  return (
    <div
      style={{
        padding: "12px",
        borderRadius: "12px",
        background: "rgba(100,120,150,0.05)",
        border: "1px solid rgba(100,120,150,0.12)",
      }}
    >
      <div style={{ fontSize: "11px", opacity: 0.65 }}>{props.label}</div>
      <strong style={{ display: "block", marginTop: "5px", fontSize: "13px" }}>
        {props.value}
      </strong>
    </div>
  );
}

class MetroCheckErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = {
      error: null,
    };
  }

  static getDerivedStateFromError(error) {
    return {
      error: error || new Error("Unknown MetroCheck rendering error"),
    };
  }

  componentDidCatch(error, info) {
    console.error("MetroCheck render failure:", error, info);
  }

  render() {
    if (!this.state.error) {
      return this.props.children;
    }

    var message =
      this.state.error && this.state.error.message
        ? String(this.state.error.message)
        : "MetroCheck encountered an unexpected rendering error.";

    return (
      <div
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "24px",
          boxSizing: "border-box",
          background: "#f4f7fb",
          color: "#172033",
          fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        }}
      >
        <div
          style={{
            width: "min(680px, 100%)",
            padding: "24px",
            borderRadius: "16px",
            background: "#ffffff",
            border: "1px solid #e4e9f1",
            boxShadow: "0 18px 55px rgba(22,45,79,0.12)",
          }}
        >
          <div style={{ fontSize: "12px", fontWeight: 900, color: "#1769ff" }}>
            METROCHECK RECOVERY SCREEN
          </div>
          <h1 style={{ margin: "8px 0 10px", fontSize: "24px" }}>
            The app hit a rendering error
          </h1>
          <p style={{ margin: 0, lineHeight: 1.6, color: "#667085" }}>
            The page is no longer allowed to fail silently. The browser reported:
          </p>
          <pre
            style={{
              margin: "14px 0",
              padding: "12px",
              borderRadius: "10px",
              background: "#f8fafc",
              border: "1px solid #e4e9f1",
              whiteSpace: "pre-wrap",
              overflowWrap: "anywhere",
              fontSize: "12px",
            }}
          >
            {message}
          </pre>
          <button
            type="button"
            onClick={function () {
              window.location.reload();
            }}
            style={{
              minHeight: "42px",
              padding: "0 16px",
              borderRadius: "9px",
              border: 0,
              background: "#1769ff",
              color: "#ffffff",
              cursor: "pointer",
              fontWeight: 800,
            }}
          >
            Reload MetroCheck
          </button>
        </div>
      </div>
    );
  }
}

function MetroCheckRoot() {
  return (
    <MetroCheckErrorBoundary>
      <App />
    </MetroCheckErrorBoundary>
  );
}

export default MetroCheckRoot;
