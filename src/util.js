/**
 * Shared tiny helpers for tool modules.
 *
 * dir(a)   -> the target project directory (or undefined => server default)
 * req(a)   -> options bag for write calls ({ directory })
 * readOpts(a) -> options bag for read calls ({ directory })
 */
'use strict';

function dir(a) {
  if (!a) return undefined;
  return a.directory || undefined;
}

function req(a) {
  return { directory: dir(a) };
}

/**
 * Build the model-related fields for a prompt/message body.
 * Returns a partial object; spread it into the request body.
 */
function modelOpts(a) {
  const out = {};
  if (a && a.providerID || a && a.modelID) {
    out.model = { providerID: a.providerID || undefined, modelID: a.modelID || undefined };
  }
  if (a && a.variant) out.variant = a.variant;
  if (a && a.agent) out.agent = a.agent;
  if (a && a.format) out.format = a.format;
  return out;
}

module.exports = { dir, req, modelOpts };
