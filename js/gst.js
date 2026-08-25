/* GSTIN parsing and CGST/SGST/IGST computation helpers. */

function gstinStateCode(gstin) {
  if (!gstin || gstin.length < 2) return null;
  return gstin.substring(0, 2);
}

function isInterState(businessGstin, companyGstin) {
  const a = gstinStateCode(businessGstin);
  const b = gstinStateCode(companyGstin);
  if (!a || !b) return false; // default to intrastate if we can't tell
  return a !== b;
}

/**
 * Computes tax totals for a set of line items.
 * items: [{ qty, rate, gstPercent }]
 * Returns { subtotal, cgst, sgst, igst, total, lineComputed: [...] }
 */
function computeTotals(items, interState) {
  let subtotal = 0, cgst = 0, sgst = 0, igst = 0;
  const lineComputed = items.map(item => {
    const taxable = item.amount != null ? Number(item.amount) : (Number(item.qty) || 0) * (Number(item.rate) || 0);
    const taxAmount = taxable * (Number(item.gstPercent) || 0) / 100;
    let lineCgst = 0, lineSgst = 0, lineIgst = 0;
    if (interState) {
      lineIgst = taxAmount;
    } else {
      lineCgst = taxAmount / 2;
      lineSgst = taxAmount / 2;
    }
    subtotal += taxable;
    cgst += lineCgst;
    sgst += lineSgst;
    igst += lineIgst;
    return {
      ...item,
      taxable,
      cgst: lineCgst,
      sgst: lineSgst,
      igst: lineIgst,
      lineTotal: taxable + lineCgst + lineSgst + lineIgst,
    };
  });
  const total = subtotal + cgst + sgst + igst;
  return { subtotal, cgst, sgst, igst, total, lineComputed };
}
