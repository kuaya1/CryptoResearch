'use strict';
// What both connectors share on the wire: the MCP protocol versions they
// answer and the redaction of their log lines. Split out of mcp.js on review
// N2 (2026-10-26) so the engineering connector (dashboard/engineering/tools.js)
// loads only protected code, never the desk's research and portfolio modules.

const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];

// Diagnostic log lines say where a handoff got to, never what it carried:
// no token, credential, address or report text. Addresses are shortened and
// anything shaped like a token is replaced.
function redactLog(s) {
  return String(s)
    .replace(/\b(Bearer|Basic)\s+\S+/gi, '$1 [redacted]')
    .replace(/\b0x([0-9a-fA-F]{4})[0-9a-fA-F]{32}([0-9a-fA-F]{4})\b/g, '0x$1…$2')
    .replace(/\b(bc1|tb1)[02-9ac-hj-np-z]{25,62}\b/gi, '$1…')
    // Tokens and base58 addresses: long, with upper case, lower case and digits.
    .replace(/[A-Za-z0-9_-]{32,}/g, (m) => (/[A-Z]/.test(m) && /[a-z]/.test(m) && /\d/.test(m) ? '[redacted]' : m));
}

module.exports = { PROTOCOL_VERSIONS, redactLog };
