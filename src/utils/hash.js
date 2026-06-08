// Strict email format regex (RFC-like, no single-char TLD)
const EMAIL_REGEX = /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/;
const MIN_PASSWORD_LENGTH = 12;
const MAX_PASSWORD_LENGTH = 128;

// Reserved usernames (derived from the local part of the email)
const RESERVED_USERNAMES = new Set([
  'admin', 'administrator', 'developer', 'dev', 'root',
  'system', 'support', 'security', 'mixdm', 'mod', 'moderator'
]);

module.exports = {
  EMAIL_REGEX,
  MIN_PASSWORD_LENGTH,
  MAX_PASSWORD_LENGTH,
  RESERVED_USERNAMES
};
