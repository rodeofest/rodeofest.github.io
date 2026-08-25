/* Indian financial-year detection and invoice/challan auto-increment logic. */

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
        return `${prefix}${pad3(seq + 1)}`;
      }
    }
  }
  return `CH/${fy}/001`;
}
