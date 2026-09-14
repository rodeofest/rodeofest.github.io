/* jsPDF document builders for Quotations and Invoices. Requires jsPDF + jspdf-autotable (loaded via CDN in index.html). */

const PAGE_MARGIN = 14;

function fmtMoney(n) {
  return 'Rs. ' + (Number(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtDate(iso) {
  if (!iso) return '';
  // parseLocalDate (js/numbering.js) avoids the UTC-parse/local-getter mismatch
  // new Date(iso) has for a plain "YYYY-MM-DD" string — see its own comment.
  return parseLocalDate(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

/* Wraps business address/footer text for printing. Splits on real newlines into
   paragraphs first (each printed on its own line(s), same as a plain
   doc.splitTextToSize() call would already do), then within each paragraph,
   splits on " | " into chunks and greedily packs them onto as few lines as fit
   maxWidth WITHOUT ever breaking inside a chunk — so a label like "E-mail:"
   typed as "Mobile: X | E-mail: Y" can never be separated from its own value
   by an ordinary word-wrap, regardless of how the source text happens to be
   typed. A paragraph with no "|" at all falls through to the exact same
   splitTextToSize() word-wrap used everywhere else, so plain address lines are
   unaffected. Requires the caller to have already set the font/size that will
   be used to print these lines, since doc.getTextWidth() measures with
   whatever is currently active. Returns a flat array of plain-text lines. */
function wrapAddressLines(doc, text, maxWidth) {
  const paragraphs = String(text || '').split(/\r?\n/);
  const lines = [];
  paragraphs.forEach((para) => {
    const chunks = para.split(/\s*\|\s*/).filter(Boolean);
    if (chunks.length <= 1) {
      lines.push(...doc.splitTextToSize(para, maxWidth));
      return;
    }
    let current = '';
    chunks.forEach((chunk) => {
      const candidate = current ? `${current} | ${chunk}` : chunk;
      if (doc.getTextWidth(candidate) <= maxWidth) {
        current = candidate;
        return;
      }
      if (current) lines.push(current);
      if (doc.getTextWidth(chunk) <= maxWidth) {
        current = chunk;
      } else {
        const wrapped = doc.splitTextToSize(chunk, maxWidth);
        wrapped.slice(0, -1).forEach((l) => lines.push(l));
        current = wrapped[wrapped.length - 1] || '';
      }
    });
    if (current) lines.push(current);
  });
  return lines;
}

/* Logo/seal uploads accept any image/* file, but doc.addImage() needs the actual
   format to match the data — passing a hardcoded 'PNG' for a JPEG/WEBP/BMP upload
   makes jsPDF silently fail (caught below) and the image just never appears.
   Detects the real type from the data URL's mime prefix; anything unrecognized
   (including already-PNG data) falls back to 'PNG', matching prior behavior. */
function imageFormatFromDataUrl(dataUrl) {
  const match = /^data:image\/([a-zA-Z0-9.+-]+);/.exec(dataUrl || '');
  const type = match ? match[1].toLowerCase() : '';
  if (type === 'jpeg' || type === 'jpg') return 'JPEG';
  if (type === 'webp') return 'WEBP';
  if (type === 'bmp') return 'BMP';
  return 'PNG';
}

/* Business Profile's Logo Width/Height fields are entered in px (the unit
   users think in for on-screen images); jsPDF works in mm. Standard 96dpi
   CSS-px assumption, matching how browsers report image/element sizes. */
function pxToMm(px) {
  return px * 25.4 / 96;
}

/* Parses a strict "#rrggbb" hex color into a [r,g,b] triple for
   doc.setTextColor(r,g,b). Returns null for anything else (blank, malformed,
   or a legacy profile saved before this field existed) so callers can fall
   back to the default text color instead of erroring on bad data. */
function hexToRgb(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/* Draws the shared document header: logo + business name/address/GSTIN on the
   left, doc title/no/date (+ extraRightLines) on the right, a divider, then
   the "To"/"Bill To" block (+ extraLeftLines) below it. Returns the Y content
   should start at below the header.

   `measureOnly` (used to size the top margin reserved for this header when
   it's repeated on later pages — see startNewPage/didDrawPage below) runs the
   exact same layout math but skips every actual ink-producing call
   (doc.text/addImage/line), so the returned height is always guaranteed
   consistent with what a real call would draw — no separate height formula
   to keep in sync. Font/size are still set in measure mode since
   wrapAddressLines()'s doc.getTextWidth() measures with whatever is active.

   `includeBillTo` (defaults true) controls whether the "To"/"Bill To" block
   (+ extraLeftLines) is drawn at all — page 1's own call always wants it, but
   the repeated header on continuation pages (startNewPage/didDrawPage) only
   wants the business letterhead + doc title/no/date repeated, not the
   customer's "To" block, so those call sites pass false. */
function drawHeader(doc, profile, company, opts, measureOnly, includeBillTo) {
  if (includeBillTo === undefined) includeBillTo = true;
  opts = Object.assign({
    docTitle: '', docNo: '', docDate: '',
    noLabel: 'No:', dateLabel: 'Date:',
    extraRightLines: [], toLabel: 'Bill To:', extraLeftLines: [],
  }, opts || {});
  let y = 16;
  const pageWidth = doc.internal.pageSize.getWidth();

  const DEFAULT_LOGO_MM = 24;
  const logoWidthMm = profile.logoWidthPx ? pxToMm(Number(profile.logoWidthPx)) : DEFAULT_LOGO_MM;
  const logoHeightMm = profile.logoHeightPx ? pxToMm(Number(profile.logoHeightPx)) : DEFAULT_LOGO_MM;

  if (profile.logoDataUrl && !measureOnly) {
    try {
      doc.addImage(profile.logoDataUrl, imageFormatFromDataUrl(profile.logoDataUrl), PAGE_MARGIN, 10, logoWidthMm, logoHeightMm);
    } catch (e) { /* ignore unreadable image */ }
  }

  const textX = profile.logoDataUrl ? PAGE_MARGIN + logoWidthMm + 6 : PAGE_MARGIN;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  if (!measureOnly) {
    const nameColor = hexToRgb(profile.nameColor);
    if (nameColor) doc.setTextColor(nameColor[0], nameColor[1], nameColor[2]);
    doc.text(profile.name || 'Your Business Name', textX, y);
    if (nameColor) doc.setTextColor(0);
  }
  y += 6;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  const addrLines = wrapAddressLines(doc, profile.address || '', 100);
  if (!measureOnly) doc.text(addrLines, textX, y);
  y += addrLines.length * 4;
  if (profile.gstin) {
    if (!measureOnly) doc.text(`GSTIN: ${profile.gstin}`, textX, y);
    y += 4;
  }

  // Title block, right aligned
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  if (!measureOnly) doc.text(opts.docTitle, pageWidth - PAGE_MARGIN, 16, { align: 'right' });
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  let rightY = 23;
  if (!measureOnly) doc.text(`${opts.noLabel} ${opts.docNo}`, pageWidth - PAGE_MARGIN, rightY, { align: 'right' });
  rightY += 5;
  if (!measureOnly) doc.text(`${opts.dateLabel} ${fmtDate(opts.docDate)}`, pageWidth - PAGE_MARGIN, rightY, { align: 'right' });
  opts.extraRightLines.forEach((line) => {
    rightY += 5;
    if (!measureOnly) doc.text(`${line.label} ${line.value}`, pageWidth - PAGE_MARGIN, rightY, { align: 'right' });
  });

  y = Math.max(y, rightY + 8) + 4;
  if (!measureOnly) {
    doc.setDrawColor(180);
    doc.line(PAGE_MARGIN, y, pageWidth - PAGE_MARGIN, y);
  }
  y += 7;

  if (!includeBillTo) {
    return y;
  }

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  if (!measureOnly) doc.text(opts.toLabel, PAGE_MARGIN, y);
  y += 5;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  if (!measureOnly) doc.text(company ? company.name : '', PAGE_MARGIN, y);
  y += 4;
  const companyAddrLines = doc.splitTextToSize(company ? (company.address || '') : '', 120);
  if (!measureOnly) doc.text(companyAddrLines, PAGE_MARGIN, y);
  y += companyAddrLines.length * 4;
  if (company && company.gstin) {
    if (!measureOnly) doc.text(`GSTIN: ${company.gstin}`, PAGE_MARGIN, y);
    y += 4;
  }

  if (opts.extraLeftLines.length) {
    y += 4;
  }

  opts.extraLeftLines.forEach((line) => {
    if (!measureOnly) doc.text(`${line.label} ${line.value}`, PAGE_MARGIN, y);
    y += 4;
  });

  return y + 4;
}

/* Adds a new page and immediately redraws the same document header on it
   (identical to page 1's), returning the Y content should resume at. Used
   for every manual page-break point in the 4 PDF builders below, so a
   document is never left with an unlabeled continuation page. */
function startNewPage(doc, profile, company, headerOpts) {
  doc.addPage();
  return drawHeader(doc, profile, company, headerOpts, false, false);
}

function drawFooter(doc, profile) {
  const pageCount = doc.internal.getNumberOfPages();
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const addr = (profile.footerText && profile.footerText.trim())
    ? profile.footerText.trim()
    : [profile.name, profile.address].filter(Boolean).join(' | ');
  // Font/size set here (before measuring) since wrapAddressLines' getTextWidth
  // calls measure using whatever font is currently active on doc.
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  const footerLines = wrapAddressLines(doc, addr, pageWidth - PAGE_MARGIN * 2 - 40);
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setDrawColor(200);
    doc.line(PAGE_MARGIN, pageHeight - 16, pageWidth - PAGE_MARGIN, pageHeight - 16);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(110);
    doc.text(footerLines, pageWidth / 2, pageHeight - 11, { align: 'center' });
    doc.text(`Page ${i} of ${pageCount}`, pageWidth - PAGE_MARGIN, pageHeight - 11, { align: 'right' });
    doc.setTextColor(0);
  }
}

function computeLineAmounts(it) {
  const taxable = (Number(it.qty) || 0) * (Number(it.rate) || 0);
  const tax = taxable * (Number(it.gstPercent) || 0) / 100;
  return { taxable, tax };
}

function buildQuotationItemRows(items, showRequired, showAmount) {
  return items.map((it, idx) => {
    const productCell = it.details ? `${it.name}\n${it.details}` : it.name;
    const row = [String(idx + 1), productCell, `${it.qty} ${it.unit || ''}`.trim()];
    if (showRequired) row.push(Number(it.requiredQty) > 0 ? String(it.requiredQty) : '-');
    row.push(`${fmtMoney(it.rate)} per ${it.unit || 'unit'}`);
    if (showAmount) {
      const required = Number(it.requiredQty) || 0;
      const qty = Number(it.qty) || 0;
      const rate = Number(it.rate) || 0;
      const amount = it.amount != null ? Number(it.amount) : (required > 0 ? required : qty) * rate;
      row.push(fmtMoney(amount));
    }
    return row;
  });
}

function buildInvoiceItemRows(items) {
  return items.map((it, idx) => {
    const { taxable, tax } = computeLineAmounts(it);
    const productCell = it.details ? `${it.name}\n${it.details}` : it.name;
    return [
      String(idx + 1),
      productCell,
      it.hsnCode || '',
      String(it.qty),
      fmtMoney(it.rate),
      it.unit || '',
      `${it.gstPercent || 0}%`,
      fmtMoney(tax),
      fmtMoney(taxable + tax),
    ];
  });
}

function drawTotalsBlock(doc, startY, totals, displayOptions) {
  const opts = Object.assign({ showSubtotal: true, showTax: true, showGrandTotal: true, advanceAmount: null }, displayOptions || {});
  const pageWidth = doc.internal.pageSize.getWidth();
  const labelX = pageWidth - PAGE_MARGIN - 60;
  const valueX = pageWidth - PAGE_MARGIN;
  let y = startY;
  doc.setFontSize(9);
  const rows = [];
  if (opts.showSubtotal) rows.push(['Subtotal', totals.subtotal]);
  if (opts.showTax) {
    rows.push(['CGST', totals.cgst], ['SGST', totals.sgst], ['IGST', totals.igst]);
  }
  rows.forEach(([label, val]) => {
    if (val === 0 && (label === 'CGST' || label === 'SGST' || label === 'IGST')) return;
    doc.setFont('helvetica', 'normal');
    doc.text(label, labelX, y);
    doc.text(fmtMoney(val), valueX, y, { align: 'right' });
    y += 5;
  });
  if (opts.showGrandTotal) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.text('Grand Total', labelX, y + 1);
    doc.text(fmtMoney(totals.total), valueX, y + 1, { align: 'right' });
    y += 8;
  }
  if (opts.advanceAmount != null) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.text('Less: Advance Received', labelX, y);
    doc.text(fmtMoney(opts.advanceAmount), valueX, y, { align: 'right' });
    y += 5;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.text('Balance Due', labelX, y);
    doc.text(fmtMoney(totals.total - opts.advanceAmount), valueX, y, { align: 'right' });
    y += 7;
  }
  return y;
}

/* Draws the "For {business name}" / seal (image or placeholder box) /
   "Authorized Signatory" block starting at startY, right-aligned near the
   page margin. Shared by buildInvoicePdf and buildServiceReportPdf — it only
   ever reads the issuing business's own profile, never document-specific
   fields. Returns the Y the signatory caption was drawn at, in case a caller
   needs to know how much vertical space this consumed. */
function drawSealSignatoryBlock(doc, startY, profile, opts) {
  opts = Object.assign({ includeSeal: true, includeSignatory: true }, opts || {});
  const pageWidth = doc.internal.pageSize.getWidth();
  const sealX = pageWidth - PAGE_MARGIN - 45;
  const sealY = startY;
  const sealAreaHeight = 20;
  const forNameY = sealY - 3;
  const signatoryY = sealY + sealAreaHeight + 4;

  if (opts.includeSignatory) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(0);
    doc.text(`For ${profile.name || 'Business Name'}`, sealX + 20, forNameY, { align: 'center' });
  }

  if (opts.includeSeal) {
    if (profile.sealDataUrl) {
      try {
        doc.addImage(profile.sealDataUrl, imageFormatFromDataUrl(profile.sealDataUrl), sealX, sealY, 40, sealAreaHeight);
      } catch (e) { /* ignore */ }
    } else {
      doc.setDrawColor(180);
      doc.rect(sealX, sealY, 40, sealAreaHeight);
      doc.setFontSize(8);
      doc.setTextColor(150);
      doc.text('Company Seal', sealX + 20, sealY + sealAreaHeight / 2 + 2, { align: 'center' });
      doc.setTextColor(0);
    }
  }

  if (opts.includeSignatory) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(0);
    doc.text('Authorized Signatory', sealX + 20, signatoryY, { align: 'center' });
  }

  return signatoryY;
}

function buildQuotationPdf(quotation, company, profile) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  const headerOpts = {
    docTitle: 'QUOTATION',
    docNo: quotation.quotationNo,
    docDate: quotation.date,
    noLabel: 'Quote No:',
    dateLabel: 'Quote Date:',
    toLabel: 'To:',
  };
  const tableStartY = drawHeader(doc, profile, company, headerOpts);
  const repeatHeaderHeight = drawHeader(doc, profile, company, headerOpts, true, false);

  const showRequired = quotation.items.some(it => Number(it.requiredQty) > 0);
  const showAmount = !!(quotation.displayOptions && quotation.displayOptions.showAmount);
  const head = ['#', 'Product', 'Qty', 'Rate'];
  if (showRequired) head.splice(3, 0, 'Required');
  if (showAmount) head.push('Amount');

  doc.autoTable({
    startY: tableStartY,
    head: [head],
    body: buildQuotationItemRows(quotation.items, showRequired, showAmount),
    margin: { left: PAGE_MARGIN, right: PAGE_MARGIN, top: repeatHeaderHeight },
    styles: { fontSize: 8, cellPadding: 2, overflow: 'linebreak' },
    headStyles: { fillColor: [40, 55, 90] },
    bodyStyles: { fontSize: 9, textColor: [0, 0, 0] },
    columnStyles: { 0: { cellWidth: 8 }, 1: { cellWidth: 52 } },
    didDrawPage: (data) => { if (data.pageNumber > 1) drawHeader(doc, profile, company, headerOpts, false, false); },
  });

  let y = doc.lastAutoTable.finalY + 8;
  y = drawTotalsBlock(doc, y, quotation, quotation.displayOptions);

  if (quotation.terms && quotation.terms.length) {
    const pageHeight = doc.internal.pageSize.getHeight();
    const pageWidth = doc.internal.pageSize.getWidth();
    if (y > pageHeight - 55) { y = startNewPage(doc, profile, company, headerOpts); }
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.text('Terms & Conditions', PAGE_MARGIN, y);
    y += 5;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    quotation.terms.forEach((term, idx) => {
      const lines = doc.splitTextToSize(`${idx + 1}. ${term}`, pageWidth - PAGE_MARGIN * 2);
      if (y + lines.length * 4.5 > pageHeight - 20) { y = startNewPage(doc, profile, company, headerOpts); }
      doc.text(lines, PAGE_MARGIN, y);
      y += lines.length * 4.5 + 1;
    });
  }

  drawFooter(doc, profile);
  return doc;
}

/* AMC Quotation item rows — no Qty/Required/Unit/Amount, and (unlike regular
   Quotation's buildQuotationItemRows) Rate never prints a "per {unit}" suffix,
   since Unit is never shown for this document type at all. */
function buildAmcItemRows(items) {
  return items.map((it, idx) => {
    const productCell = it.details ? `${it.name}\n${it.details}` : it.name;
    return [String(idx + 1), productCell, fmtMoney(it.rate)];
  });
}

/* Consumable Rates rows — Product/Qty/Rate only (no Required/Unit/Amount),
   same no-"per unit" treatment as buildAmcItemRows. Purely a reference price
   list — never summed into the quotation's own totals. */
function buildAmcConsumableRows(consumables) {
  return consumables.map((it, idx) => {
    const productCell = it.details ? `${it.name}\n${it.details}` : it.name;
    return [String(idx + 1), productCell, String(it.qty), fmtMoney(it.rate)];
  });
}

function buildAmcQuotationPdf(quotation, company, profile) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const headerOpts = {
    docTitle: 'AMC QUOTATION',
    docNo: quotation.quotationNo,
    docDate: quotation.date,
    noLabel: 'Quote No:',
    dateLabel: 'Quote Date:',
    toLabel: 'To:',
  };
  let y = drawHeader(doc, profile, company, headerOpts);
  const repeatHeaderHeight = drawHeader(doc, profile, company, headerOpts, true, false);

  if (quotation.heading) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12);
    doc.setTextColor(0);
    const headingLines = doc.splitTextToSize(quotation.heading, pageWidth - PAGE_MARGIN * 2);
    if (y + headingLines.length * 5 > pageHeight - 20) { y = startNewPage(doc, profile, company, headerOpts); }
    doc.text(headingLines, pageWidth / 2, y, { align: 'center' });
    y += headingLines.length * 5 + 4;
  }

  doc.autoTable({
    startY: y,
    head: [['#', 'Product', 'Rate']],
    body: buildAmcItemRows(quotation.items),
    margin: { left: PAGE_MARGIN, right: PAGE_MARGIN, top: repeatHeaderHeight },
    styles: { fontSize: 8, cellPadding: 2, overflow: 'linebreak' },
    headStyles: { fillColor: [40, 55, 90] },
    bodyStyles: { fontSize: 9, textColor: [0, 0, 0] },
    columnStyles: { 0: { cellWidth: 8 }, 1: { cellWidth: 52 } },
    didDrawPage: (data) => { if (data.pageNumber > 1) drawHeader(doc, profile, company, headerOpts, false, false); },
  });

  y = doc.lastAutoTable.finalY + 8;
  y = drawTotalsBlock(doc, y, quotation, quotation.displayOptions);

  if (quotation.terms && quotation.terms.length) {
    if (y > pageHeight - 55) { y = startNewPage(doc, profile, company, headerOpts); }
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.setTextColor(0);
    doc.text('Terms & Conditions', PAGE_MARGIN, y);
    y += 5;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    quotation.terms.forEach((term, idx) => {
      const lines = doc.splitTextToSize(`${idx + 1}. ${term}`, pageWidth - PAGE_MARGIN * 2);
      if (y + lines.length * 4.5 > pageHeight - 20) { y = startNewPage(doc, profile, company, headerOpts); }
      doc.text(lines, PAGE_MARGIN, y);
      y += lines.length * 4.5 + 1;
    });
  }

  // Consumable Rates is a reference-only appendix — always starts on a fresh
  // page regardless of remaining space, and is the last content section of
  // the document (nothing else is drawn after its table besides the footer).
  // It still gets the repeated header like every other page, via startNewPage.
  y = startNewPage(doc, profile, company, headerOpts);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.setTextColor(0);
  const consumableHeading = quotation.consumableHeading || 'Consumable Rates';
  const consumableHeadingLines = doc.splitTextToSize(consumableHeading, pageWidth - PAGE_MARGIN * 2);
  doc.text(consumableHeadingLines, pageWidth / 2, y, { align: 'center' });
  y += consumableHeadingLines.length * 5 + 4;

  doc.autoTable({
    startY: y,
    head: [['#', 'Product', 'Qty', 'Rate']],
    body: buildAmcConsumableRows(quotation.consumables || []),
    margin: { left: PAGE_MARGIN, right: PAGE_MARGIN, top: repeatHeaderHeight },
    styles: { fontSize: 8, cellPadding: 2, overflow: 'linebreak' },
    headStyles: { fillColor: [40, 55, 90] },
    bodyStyles: { fontSize: 9, textColor: [0, 0, 0] },
    columnStyles: { 0: { cellWidth: 8 }, 1: { cellWidth: 52 } },
    didDrawPage: (data) => { if (data.pageNumber > 1) drawHeader(doc, profile, company, headerOpts, false, false); },
  });

  drawFooter(doc, profile);
  return doc;
}

function buildInvoicePdf(invoice, company, profile) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  const headerOpts = {
    docTitle: invoice.isProforma ? 'PROFORMA INVOICE' : 'TAX INVOICE',
    docNo: invoice.invoiceNo,
    docDate: invoice.date,
    noLabel: 'Invoice No:',
    dateLabel: 'Invoice Date:',
    extraRightLines: [
      { label: 'Challan No:', value: invoice.challanNo || (invoice.showChallanDash ? '-' : '') },
      { label: 'Challan Date:', value: invoice.challanDate ? fmtDate(invoice.challanDate) : (invoice.showChallanDash ? '-' : '') },
    ],
    toLabel: 'Bill To:',
    extraLeftLines: [
      { label: 'PO No:', value: invoice.poNumber || '' },
      { label: 'PO Date:', value: invoice.poDate ? fmtDate(invoice.poDate) : '' },
    ],
  };
  const tableStartY = drawHeader(doc, profile, company, headerOpts);
  const repeatHeaderHeight = drawHeader(doc, profile, company, headerOpts, true, false);

  doc.autoTable({
    startY: tableStartY,
    head: [['#', 'Product', 'HSN', 'Qty', 'Rate', 'Per', 'GST%', 'Tax', 'Amount']],
    body: buildInvoiceItemRows(invoice.items),
    margin: { left: PAGE_MARGIN, right: PAGE_MARGIN, top: repeatHeaderHeight },
    styles: { fontSize: 8, cellPadding: 2, overflow: 'linebreak' },
    headStyles: { fillColor: [40, 55, 90] },
    bodyStyles: { fontSize: 9, textColor: [0, 0, 0] },
    columnStyles: { 0: { cellWidth: 8 }, 1: { cellWidth: 52 } },
    didDrawPage: (data) => { if (data.pageNumber > 1) drawHeader(doc, profile, company, headerOpts, false, false); },
  });

  let y = doc.lastAutoTable.finalY + 8;
  y = drawTotalsBlock(doc, y, invoice, {
    advanceAmount: invoice.isAdvancePayment ? (Number(invoice.advanceAmount) || 0) : null,
  });

  doc.setFont('helvetica', 'italic');
  doc.setFontSize(9);
  const wordsLines = doc.splitTextToSize(`Amount in Words: ${invoice.amountInWords || amountInWords(invoice.total)}`, 180);
  doc.text(wordsLines, PAGE_MARGIN, y);
  y += wordsLines.length * 5 + 6;

  const pageHeight = doc.internal.pageSize.getHeight();
  if (y > pageHeight - 55) {
    y = startNewPage(doc, profile, company, headerOpts);
  }

  const pageWidth = doc.internal.pageSize.getWidth();
  doc.setDrawColor(200);
  doc.line(PAGE_MARGIN, y, pageWidth - PAGE_MARGIN, y);
  y += 7;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.text('Bank Details', PAGE_MARGIN, y);
  y += 5;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  const bankLines = [
    profile.bankName ? `Bank Name: ${profile.bankName}` : null,
    profile.bankAccountNo ? `Account No: ${profile.bankAccountNo}` : null,
    profile.bankIFSC ? `IFSC: ${profile.bankIFSC}` : null,
    profile.bankBranch ? `Branch: ${profile.bankBranch}` : null,
  ].filter(Boolean);
  doc.text(bankLines.length ? bankLines : ['Bank details not set'], PAGE_MARGIN, y);

  drawSealSignatoryBlock(doc, y, profile, {
    includeSeal: invoice.includeSeal !== false,
    includeSignatory: invoice.includeSignatory !== false,
  });

  drawFooter(doc, profile);
  return doc;
}

/* Service Report: header (via the shared drawHeader), a free-edit reference
   paragraph, any number of user-configured free-form tables (no semantic
   header row — every row is user-entered data), an optional numbered Notes
   list, then the same seal/signatory block Invoice uses. */
function buildServiceReportPdf(report, company, profile) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const headerOpts = {
    docTitle: 'SERVICE REPORT',
    docNo: report.reportNo,
    docDate: report.date,
    noLabel: 'Report No:',
    dateLabel: 'Report Date:',
    toLabel: 'To:',
  };
  let y = drawHeader(doc, profile, company, headerOpts);
  const repeatHeaderHeight = drawHeader(doc, profile, company, headerOpts, true, false);

  if (report.heading) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12);
    doc.setTextColor(0);
    const headingLines = doc.splitTextToSize(report.heading, pageWidth - PAGE_MARGIN * 2);
    if (y + headingLines.length * 5 > pageHeight - 20) { y = startNewPage(doc, profile, company, headerOpts); }
    doc.text(headingLines, pageWidth / 2, y, { align: 'center' });
    y += headingLines.length * 5 + 4;
  }

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(0);
  doc.text(`Date of Service: ${report.serviceDate ? fmtDate(report.serviceDate) : ''}`, PAGE_MARGIN, y);
  y += 8;

  if (report.paragraph) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.setTextColor(0);
    const lines = doc.splitTextToSize(report.paragraph, pageWidth - PAGE_MARGIN * 2);
    if (y + lines.length * 5 > pageHeight - 20) { y = startNewPage(doc, profile, company, headerOpts); }
    doc.text(lines, PAGE_MARGIN, y);
    y += lines.length * 5 + 6;
  }

  // Free-form tables: no semantic header row unless the user opted into one
  // via "Header Row" — everything is user-entered data either way, so the
  // header (when present) is just the table's own first row promoted into
  // autoTable's head slot for the bold/navy styling. jspdf-autotable
  // auto-paginates on its own, so no manual page-break guard is needed here
  // (unlike the paragraph/notes text blocks) — didDrawPage repeats the
  // document header on any page autoTable adds internally.
  (report.tables || []).forEach((t) => {
    if (!t.data || !t.data.length) return;
    const hasHeader = !!t.hasHeader;
    doc.autoTable({
      startY: y,
      head: hasHeader ? [t.data[0]] : [],
      body: hasHeader ? t.data.slice(1) : t.data,
      margin: { left: PAGE_MARGIN, right: PAGE_MARGIN, top: repeatHeaderHeight },
      styles: { fontSize: 8, cellPadding: 2, overflow: 'linebreak' },
      headStyles: { fillColor: [40, 55, 90] },
      bodyStyles: { fontSize: 9, textColor: [0, 0, 0] },
      didDrawPage: (data) => { if (data.pageNumber > 1) drawHeader(doc, profile, company, headerOpts, false, false); },
    });
    y = doc.lastAutoTable.finalY + 8;
  });

  if (report.notes && report.notes.length) {
    if (y > pageHeight - 55) { y = startNewPage(doc, profile, company, headerOpts); }
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.setTextColor(0);
    doc.text('Notes', PAGE_MARGIN, y);
    y += 5;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    report.notes.forEach((note, idx) => {
      const lines = doc.splitTextToSize(`${idx + 1}. ${note}`, pageWidth - PAGE_MARGIN * 2);
      if (y + lines.length * 4.5 > pageHeight - 20) { y = startNewPage(doc, profile, company, headerOpts); }
      doc.text(lines, PAGE_MARGIN, y);
      y += lines.length * 4.5 + 1;
    });
    y += 6;
  }

  if (y > pageHeight - 45) { y = startNewPage(doc, profile, company, headerOpts); }
  drawSealSignatoryBlock(doc, y, profile, {
    includeSeal: report.includeSeal !== false,
    includeSignatory: report.includeSignatory !== false,
  });

  drawFooter(doc, profile);
  return doc;
}
