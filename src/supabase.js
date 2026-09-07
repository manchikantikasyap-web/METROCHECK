import { createClient } from "@supabase/supabase-js";

/*
 * MetroCheck Supabase bootstrap.
 *
 * IMPORTANT:
 * A malformed or placeholder .env value must NEVER crash the whole React app.
 * createClient() validates the URL synchronously, so an invalid URL can otherwise
 * produce a completely blank page before React gets a chance to render anything.
 */
function cleanEnvValue(value) {
  return String(value || "")
    .trim()
    .replace(/^['"]|['"]$/g, "")
    .trim();
}

function isPlaceholder(value) {
  var text = String(value || "").toLowerCase();

  return (
    !text ||
    text.includes("your_supabase") ||
    text.includes("your_full") ||
    text.includes("your_publishable") ||
    text.includes("paste_") ||
    text.includes("replace_")
  );
}

function isValidHttpUrl(value) {
  try {
    var parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch (error) {
    return false;
  }
}

var env = import.meta.env || {};

var supabaseUrl = cleanEnvValue(env.VITE_SUPABASE_URL);
var supabasePublishableKey = cleanEnvValue(
  env.VITE_SUPABASE_PUBLISHABLE_KEY || env.VITE_SUPABASE_ANON_KEY
);

var client = null;
var configError = "";

if (isPlaceholder(supabaseUrl) || isPlaceholder(supabasePublishableKey)) {
  configError =
    "Supabase is not configured yet. Add the real VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY values to the project-root .env file, save it, and restart Vite.";
} else if (!isValidHttpUrl(supabaseUrl)) {
  configError =
    "VITE_SUPABASE_URL is not a valid http/https URL. Copy the complete Project URL from Supabase and restart Vite.";
} else {
  try {
    client = createClient(supabaseUrl, supabasePublishableKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    });
  } catch (error) {
    console.error("MetroCheck Supabase initialization failed:", error);
    configError =
      error && error.message
        ? "Supabase could not initialize: " + error.message
        : "Supabase could not initialize. Check the values in .env and restart Vite.";
    client = null;
  }
}

export const supabase = client;
export const supabaseReady = Boolean(client);
export const supabaseConfigError = configError;