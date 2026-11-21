// Fast drop-in replacement for csv-reader 1.0.0 (make.fun bounty csv-reader-speed-01).
//
// run(input) returns exactly what the reference readCsv(input) returns —
// { columns, rows, errors } — for every input, broken rows included. The
// reference walks the text one character at a time and builds each field by
// concatenation; this version scans with indexOf and slices whole runs at
// once. Four monotonic "next occurrence" caches (comma, LF, CR, quote) mean
// every delimiter position in the text is located exactly once per parse, so
// the native scanning stays linear even when a delimiter is rare or absent.
//
// Semantics replicated from the reference, in the order it produces them:
// a leading U+FEFF is skipped; empty lines are no records; a lone CR outside
// quotes is dropped (stray_cr); a quoted field turns "" into one quote and
// each CR or CRLF inside it into one LF; junk after a closing quote is
// appended as an unquoted read and reported (quote_junk) when it adds at
// least one character; a quote that never closes is reported
// (unterminated_quote) and the field is re-read as unquoted starting from a
// literal quote; a record made of a single empty unquoted field (a line of
// nothing but stray CRs) is discarded but keeps its errors; the first kept
// record fixes the width, later records are padded (short_row) or cut
// (long_row) to it, and the first record is the columns when header is true.

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

// Indices into the next-occurrence cache.
const K_COMMA = 0;
const K_LF = 1;
const K_CR = 2;
const K_QUOTE = 3;
const CACHE_CHARS = [',', '\n', '\r', '"'];

export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;

  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0;
  let line = 1;
  if (n > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  let recordLine = 1;
  let recordRow = null;

  // How the most recent field read ended, and how many characters an
  // unquoted read kept (the quote_junk test needs the count).
  let fEnded = END;
  let fAdded = 0;

  // nxt[k] is the first index >= every position queried so far at which
  // CACHE_CHARS[k] occurs, Infinity when none is left, -2 when unknown.
  // Queries only move forward; the one backward jump (the unterminated-quote
  // re-read) resets the cache.
  const nxt = [-2, -2, -2, -2];

  function peek(kind, from) {
    const v = nxt[kind];
    if (v < from) {
      const found = text.indexOf(CACHE_CHARS[kind], from);
      nxt[kind] = found === -1 ? Infinity : found;
      return nxt[kind];
    }
    return v;
  }

  function advance(kind) {
    const v = nxt[kind];
    if (v === Infinity) return;
    const found = text.indexOf(CACHE_CHARS[kind], v + 1);
    nxt[kind] = found === -1 ? Infinity : found;
  }

  // Number of LFs in text[from, to); the LF cache walks them in order.
  function countLF(from, to) {
    let count = 0;
    let i = peek(K_LF, from);
    while (i < to) {
      count += 1;
      advance(K_LF);
      i = nxt[K_LF];
    }
    return count;
  }

  // Reads unquoted characters onto value up to the next comma or line break.
  // A CR not followed by LF is dropped and reported as stray_cr.
  function readUnquoted(value) {
    let added = 0;
    for (;;) {
      if (pos >= n) {
        fEnded = END;
        fAdded = added;
        return value;
      }
      const iComma = peek(K_COMMA, pos);
      const iLf = peek(K_LF, pos);
      const iCr = peek(K_CR, pos);
      let idx = iComma;
      let kind = 44;
      if (iLf < idx) {
        idx = iLf;
        kind = 10;
      }
      if (iCr < idx) {
        idx = iCr;
        kind = 13;
      }
      if (idx === Infinity) {
        value += text.slice(pos);
        added += n - pos;
        pos = n;
        fEnded = END;
        fAdded = added;
        return value;
      }
      if (kind === 44) {
        value += text.slice(pos, idx);
        added += idx - pos;
        pos = idx + 1;
        fEnded = COMMA;
        fAdded = added;
        return value;
      }
      if (kind === 10) {
        value += text.slice(pos, idx);
        added += idx - pos;
        pos = idx + 1;
        line += 1;
        fEnded = LINE_BREAK;
        fAdded = added;
        return value;
      }
      // kind === 13: a CR ends the field only as part of a CRLF.
      if (idx + 1 < n && text.charCodeAt(idx + 1) === 10) {
        value += text.slice(pos, idx);
        added += idx - pos;
        pos = idx + 2;
        line += 1;
        fEnded = LINE_BREAK;
        fAdded = added;
        return value;
      }
      value += text.slice(pos, idx);
      added += idx - pos;
      errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
      pos = idx + 1;
    }
  }

  // What follows a closing quote: end of text, a comma, a line break, or
  // junk read as unquoted text appended to the quoted value.
  function afterQuote(value) {
    if (pos >= n) {
      fEnded = END;
      fAdded = 0;
      return value;
    }
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      fEnded = COMMA;
      fAdded = 0;
      return value;
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      fEnded = LINE_BREAK;
      fAdded = 0;
      return value;
    }
    if (c === 13 && pos + 1 < n && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      fEnded = LINE_BREAK;
      fAdded = 0;
      return value;
    }
    const joined = readUnquoted(value);
    if (fAdded > 0) {
      errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
    }
    return joined;
  }

  // Reads a quoted field whose opening quote is at pos.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    pos += 1;

    // Common case: the next quote closes the field and no CR comes first,
    // so the value is one slice and only its LFs move the line counter.
    const firstQuote = peek(K_QUOTE, pos);
    if (firstQuote !== Infinity) {
      const firstCr = peek(K_CR, pos);
      if (
        firstCr > firstQuote &&
        (firstQuote + 1 >= n || text.charCodeAt(firstQuote + 1) !== 34)
      ) {
        const value = text.slice(pos, firstQuote);
        line += countLF(pos, firstQuote);
        pos = firstQuote + 1;
        return afterQuote(value);
      }
    }

    // General case: doubled quotes and CRs inside force part-accumulation.
    let value = '';
    let seg = pos;
    let scan = pos;
    for (;;) {
      const q = peek(K_QUOTE, scan);
      if (q === Infinity) {
        // The quote never closes: it is a literal character, and the text
        // after it is read again as an unquoted field.
        pos = open + 1;
        line = openLine;
        nxt[0] = -2;
        nxt[1] = -2;
        nxt[2] = -2;
        nxt[3] = -2;
        errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
        return readUnquoted('"');
      }
      const r = peek(K_CR, scan);
      if (r < q) {
        // A CR (or CRLF) inside the quotes becomes a single LF.
        value += text.slice(seg, r);
        line += countLF(seg, r) + 1;
        value += '\n';
        scan = r + 1 < n && text.charCodeAt(r + 1) === 10 ? r + 2 : r + 1;
        seg = scan;
        continue;
      }
      if (q + 1 < n && text.charCodeAt(q + 1) === 34) {
        // A doubled quote is one literal quote.
        value += text.slice(seg, q);
        line += countLF(seg, q);
        value += '"';
        scan = q + 2;
        seg = scan;
        continue;
      }
      // A quote not followed by another quote closes the field.
      value += text.slice(seg, q);
      line += countLF(seg, q);
      pos = q + 1;
      return afterQuote(value);
    }
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && pos + 1 < n && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let lastQuoted = false;
    for (;;) {
      lastQuoted = pos < n && text.charCodeAt(pos) === 34;
      fields.push(lastQuoted ? readQuoted() : readUnquoted(''));
      if (fEnded !== COMMA) break;
    }

    // A line that held only stray CRs is left with no characters: no
    // record, but the errors it produced stay.
    if (fields.length === 1 && fields[0] === '' && !lastQuoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  return { columns: header ? (columns ?? []) : null, rows, errors };
}
