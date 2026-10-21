// Small RFC 4180 CSV reader (quoted fields, "" escapes, newlines inside quotes, CRLF/LF/CR,
// UTF-8 BOM). No dependency; the bulk import is the only consumer.

// Pick the delimiter from the first line: comma, semicolon (common in Excel exports for
// many locales) or tab. Quoted text on the header line is ignored when counting.
export function detectDelimiter(text) {
  let inQuotes = false;
  const counts = { ',': 0, ';': 0, '\t': 0 };
  for (const ch of text) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && (ch === '\n' || ch === '\r')) break;
    else if (!inQuotes && ch in counts) counts[ch]++;
  }
  const [best, n] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return n > 0 ? best : ',';
}

// Returns { records: [{ row, cells: string[] }] } or { error }.
// `row` is the 1-based record number, counting blank lines, so it lines up with the row
// numbers a spreadsheet shows (the header is row 1). Blank lines are skipped.
export function parseCsv(input, delimiter = detectDelimiter(input)) {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const records = [];
  let cells = [];
  let field = '';
  let inQuotes = false;
  let wasQuoted = false; // a quoted empty field ("") is still a field
  let row = 1;

  const endField = () => {
    cells.push(field);
    field = '';
    wasQuoted = false;
  };
  const endRecord = () => {
    const quoted = wasQuoted;
    endField();
    const blank = cells.length === 1 && cells[0] === '' && !quoted;
    if (!blank) records.push({ row, cells });
    cells = [];
    row++;
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field === '') {
      inQuotes = true;
      wasQuoted = true;
    } else if (ch === delimiter) {
      endField();
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      endRecord();
    } else {
      field += ch;
    }
  }
  if (inQuotes) return { error: 'The CSV has an opening quote that is never closed' };
  if (field !== '' || cells.length > 0 || wasQuoted) endRecord();
  return { records };
}
