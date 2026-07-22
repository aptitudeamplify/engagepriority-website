"use strict";

class Stage1SchemaError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "Stage1SchemaError";
    this.code = code;
    this.details = details;
  }
}

function buildHeaderIndex(headers, { required = [], allowed = null } = {}) {
  if (!Array.isArray(headers)) {
    throw new Stage1SchemaError("SCHEMA_HEADERS_NOT_ARRAY", "Headers must be an array.");
  }

  const index = Object.create(null);
  const duplicates = [];

  headers.forEach((raw, position) => {
    const header = String(raw ?? "");

    if (!header) {
      throw new Stage1SchemaError("SCHEMA_BLANK_HEADER", "Blank headers are prohibited.", { position });
    }

    if (Object.prototype.hasOwnProperty.call(index, header)) {
      duplicates.push(header);
    } else {
      index[header] = position;
    }
  });

  if (duplicates.length) {
    throw new Stage1SchemaError("SCHEMA_DUPLICATE_HEADER", "Duplicate headers are prohibited.", {
      headers: [...new Set(duplicates)]
    });
  }

  const missing = required.filter((name) => !Object.prototype.hasOwnProperty.call(index, name));

  if (missing.length) {
    throw new Stage1SchemaError("SCHEMA_REQUIRED_HEADER_MISSING", "Required headers are missing.", {
      headers: missing
    });
  }

  if (allowed) {
    const allowedSet = new Set(allowed);
    const unknown = headers.filter((name) => !allowedSet.has(name));

    if (unknown.length) {
      throw new Stage1SchemaError("SCHEMA_UNKNOWN_HEADER", "Unknown headers are prohibited on a closed schema.", {
        headers: unknown
      });
    }
  }

  return Object.freeze(index);
}

function rowToObject(headers, row, options = {}) {
  const index = buildHeaderIndex(headers, options);
  const output = Object.create(null);

  Object.keys(index).forEach((name) => {
    output[name] = row[index[name]];
  });

  return output;
}

module.exports = {
  Stage1SchemaError,
  buildHeaderIndex,
  rowToObject
};
