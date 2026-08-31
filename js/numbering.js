/* Indian financial-year detection and invoice/challan auto-increment logic. */

/* Every date field in this app is a plain "YYYY-MM-DD" business-date string.
   `new Date(str)` parses that as UTC midnight, but .getMonth()/.getDate()/
   .toLocaleDateString() all read back in the browser's LOCAL time — for any
   timezone behind UTC, the date can resolve to the previous calendar day,
   silently shifting it across a financial-year or month boundary. Dormant for
   IST (this app's home locale, ahead of UTC), real for anyone west of UTC.
   Use this instead of `new Date(dateStr)` anywhere a date-only string needs
   its calendar components (year/month/day) read back out — pure numeric
   comparisons (sorting, `<`/`>`) are unaffected either way and don't need it. */
function parseLocalDate(dateStr) {
  if (!dateStr) return null;
  if (typeof dateStr !== 'string') return new Date(dateStr);
  const parts = dateStr.split('-').map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) return new Date(dateStr);
  return new Date(parts[0], parts[1] - 1, parts[2]);
}

function currentFinancialYear(date) {
  date = date || new Date();
  const year = date.getFullYear();
  const month = date.getMonth(); // 0 = Jan
  const startYear = month >= 3 ? year : year - 1; // FY starts in April (month index 3)
  const endYearShort = String((startYear + 1) % 100).padStart(2, '0');
  return `${startYear}-${endYearShort}`;
}

function pad3(n) {
  return String(n).padStart(3, '0');
}

function extractSeq(docNo) {
  if (!docNo) return null;
  const match = docNo.match(/(\d+)\s*$/);
  return match ? parseInt(match[1], 10) : null;
}

/** Next invoice number for the current FY, derived from the highest existing invoice number (so deletes free up their number instead of leaving a gap). */
function getNextInvoiceNo() {
  const fy = currentFinancialYear();
  const prefix = `INV/${fy}/`;
  let maxSeq = 0;
  Store.getInvoices().forEach(inv => {
    if (inv.invoiceNo && inv.invoiceNo.startsWith(prefix)) {
      const seq = extractSeq(inv.invoiceNo);
      if (seq !== null && seq > maxSeq) maxSeq = seq;
    }
  });
  return `${prefix}${pad3(maxSeq + 1)}`;
}

/** Next Proforma Invoice number for the current FY — same "scan for highest existing" pattern as getNextInvoiceNo, scoped to the PI/ prefix so it never collides with real (INV/) invoice numbers. */
function getNextProformaInvoiceNo() {
  const fy = currentFinancialYear();
  const prefix = `PI/${fy}/`;
  let maxSeq = 0;
  Store.getInvoices().forEach(inv => {
    if (inv.invoiceNo && inv.invoiceNo.startsWith(prefix)) {
      const seq = extractSeq(inv.invoiceNo);
      if (seq !== null && seq > maxSeq) maxSeq = seq;
    }
  });
  return `${prefix}${pad3(maxSeq + 1)}`;
}

/** Next quotation number, derived the same way from the highest existing quotation number. */
function getNextQuotationNo() {
  const prefix = 'QTN-';
  let maxSeq = 0;
  Store.getQuotations().forEach(q => {
    if (q.quotationNo && q.quotationNo.startsWith(prefix)) {
      const seq = extractSeq(q.quotationNo);
      if (seq !== null && seq > maxSeq) maxSeq = seq;
    }
  });
  return `${prefix}${pad3(maxSeq + 1)}`;
}

/** Next purchase number, derived the same way from the highest existing purchase number. */
function getNextPurchaseNo() {
  const prefix = 'PUR-';
  let maxSeq = 0;
  Store.getPurchases().forEach(p => {
    if (p.purchaseNo && p.purchaseNo.startsWith(prefix)) {
      const seq = extractSeq(p.purchaseNo);
      if (seq !== null && seq > maxSeq) maxSeq = seq;
    }
  });
  return `${prefix}${pad3(maxSeq + 1)}`;
}

/**
 * Challan numbering: increment from the last invoice's challan number.
 * If the last invoice has none, walk backward through prior invoices until one is found.
 * If none exist at all, start fresh at CH/{FY}/001.
 */
function getNextChallanNo() {
  const fy = currentFinancialYear();
  const invoices = Store.getInvoices()
    .slice()
    .sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));

  for (let i = invoices.length - 1; i >= 0; i--) {
    const ch = invoices[i].challanNo;
    if (ch) {
      const seq = extractSeq(ch);
      if (seq !== null) {
        const prefix = ch.replace(/\d+\s*$/, '');
        // Default-format challans (CH/{FY}/nnn) should reset to 001 once the
        // financial year rolls over, same as every other numbering scheme —
        // otherwise the sequence (and the now-stale FY tag) would just keep
        // incrementing forever. A custom, non-default prefix is left alone and
        // simply incremented, exactly as before.
        const fyMatch = prefix.match(/^CH\/(\d{4}-\d{2})\/$/);
        if (fyMatch && fyMatch[1] !== fy) {
          return `CH/${fy}/001`;
        }
        return `${prefix}${pad3(seq + 1)}`;
      }
    }
  }
  return `CH/${fy}/001`;
}
