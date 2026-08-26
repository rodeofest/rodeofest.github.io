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

function drawHeader(doc, profile, company, opts) {
  opts = Object.assign({
    docTitle: '', docNo: '', docDate: '',
    noLabel: 'No:', dateLabel: 'Date:',
    extraRightLines: [], toLabel: 'Bill To:', extraLeftLines: [],
  }, opts || {});
  let y = 16;
  const pageWidth = doc.internal.pageSize.getWidth();

  if (profile.logoDataUrl) {
    try {
      doc.addImage(profile.logoDataUrl, imageFormatFromDataUrl(profile.logoDataUrl), PAGE_MARGIN, 10, 24, 24);
    } catch (e) { /* ignore unreadable image */ }
  }

  const textX = profile.logoDataUrl ? PAGE_MARGIN + 30 : PAGE_MARGIN;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  doc.text(profile.name || 'Your Business Name', textX, y);
  y += 6;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  const addrLines = doc.splitTextToSize(profile.address || '', 100);
  doc.text(addrLines, textX, y);
  y += addrLines.length * 4;
  if (profile.gstin) {
    doc.text(`GSTIN: ${profile.gstin}`, textX, y);
    y += 4;
  }

  // Title block, right aligned
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  doc.text(opts.docTitle, pageWidth - PAGE_MARGIN, 16, { align: 'right' });
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  let rightY = 23;
  doc.text(`${opts.noLabel} ${opts.docNo}`, pageWidth - PAGE_MARGIN, rightY, { align: 'right' });
  rightY += 5;
  doc.text(`${opts.dateLabel} ${fmtDate(opts.docDate)}`, pageWidth - PAGE_MARGIN, rightY, { align: 'right' });
  opts.extraRightLines.forEach((line) => {
    rightY += 5;
    doc.text(`${line.label} ${line.value}`, pageWidth - PAGE_MARGIN, rightY, { align: 'right' });
  });

  y = Math.max(y, rightY + 8) + 4;
  doc.setDrawColor(180);
  doc.line(PAGE_MARGIN, y, pageWidth - PAGE_MARGIN, y);
  y += 7;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.text(opts.toLabel, PAGE_MARGIN, y);
  y += 5;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.text(company ? company.name : '', PAGE_MARGIN, y);
  y += 4;
  const companyAddrLines = doc.splitTextToSize(company ? (company.address || '') : '', 120);
  doc.text(companyAddrLines, PAGE_MARGIN, y);
  y += companyAddrLines.length * 4;
  if (company && company.gstin) {
    doc.text(`GSTIN: ${company.gstin}`, PAGE_MARGIN, y);
    y += 4;
  }

  if (opts.extraLeftLines.length) {
    y += 4;
  }

  opts.extraLeftLines.forEach((line) => {
    doc.text(`${line.label} ${line.value}`, PAGE_MARGIN, y);
    y += 4;
  });

  return y + 4;
}

function drawFooter(doc, profile) {
  const pageCount = doc.internal.getNumberOfPages();
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setDrawColor(200);
    doc.line(PAGE_MARGIN, pageHeight - 16, pageWidth - PAGE_MARGIN, pageHeight - 16);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(110);
    const addr = [profile.name, profile.address].filter(Boolean).join(' | ');
    doc.text(addr, pageWidth / 2, pageHeight - 11, { align: 'center' });
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
      it.unit || '',
      fmtMoney(it.rate),
      `${it.gstPercent || 0}%`,
      fmtMoney(tax),
      fmtMoney(taxable + tax),
    ];
  });
}

function drawTotalsBlock(doc, startY, totals, displayOptions) {
  const opts = Object.assign({ showSubtotal: true, showTax: true, showGrandTotal: true }, displayOptions || {});
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
  return y;
}

function buildQuotationPdf(quotation, company, profile) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  const tableStartY = drawHeader(doc, profile, company, {
    docTitle: 'QUOTATION',
    docNo: quotation.quotationNo,
    docDate: quotation.date,
    noLabel: 'Quote No:',
    dateLabel: 'Quote Date:',
    toLabel: 'To:',
  });

  const showRequired = quotation.items.some(it => Number(it.requiredQty) > 0);
  const showAmount = !!(quotation.displayOptions && quotation.displayOptions.showAmount);
  const head = ['#', 'Product', 'Qty', 'Rate'];
  if (showRequired) head.splice(3, 0, 'Required');
  if (showAmount) head.push('Amount');

  doc.autoTable({
    startY: tableStartY,
    head: [head],
    body: buildQuotationItemRows(quotation.items, showRequired, showAmount),
    margin: { left: PAGE_MARGIN, right: PAGE_MARGIN },
    styles: { fontSize: 8, cellPadding: 2, overflow: 'linebreak' },
    headStyles: { fillColor: [40, 55, 90] },
    columnStyles: { 0: { cellWidth: 8 }, 1: { cellWidth: 52 } },
  });

  let y = doc.lastAutoTable.finalY + 8;
  y = drawTotalsBlock(doc, y, quotation, quotation.displayOptions);

  if (quotation.terms && quotation.terms.length) {
    const pageHeight = doc.internal.pageSize.getHeight();
    const pageWidth = doc.internal.pageSize.getWidth();
    if (y > pageHeight - 55) { doc.addPage(); y = 20; }
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.text('Terms & Conditions', PAGE_MARGIN, y);
    y += 5;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    quotation.terms.forEach((term, idx) => {
      const lines = doc.splitTextToSize(`${idx + 1}. ${term}`, pageWidth - PAGE_MARGIN * 2);
      if (y + lines.length * 4.5 > pageHeight - 20) { doc.addPage(); y = 20; }
      doc.text(lines, PAGE_MARGIN, y);
      y += lines.length * 4.5 + 1;
    });
  }

  drawFooter(doc, profile);
  return doc;
}

function buildInvoicePdf(invoice, company, profile) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  const tableStartY = drawHeader(doc, profile, company, {
    docTitle: 'TAX INVOICE',
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
  });

  doc.autoTable({
    startY: tableStartY,
    head: [['#', 'Product', 'HSN', 'Qty', 'Per', 'Rate', 'GST%', 'Tax', 'Amount']],
    body: buildInvoiceItemRows(invoice.items),
    margin: { left: PAGE_MARGIN, right: PAGE_MARGIN },
    styles: { fontSize: 8, cellPadding: 2, overflow: 'linebreak' },
    headStyles: { fillColor: [40, 55, 90] },
    columnStyles: { 0: { cellWidth: 8 }, 1: { cellWidth: 52 } },
  });

  let y = doc.lastAutoTable.finalY + 8;
  y = drawTotalsBlock(doc, y, invoice);

  doc.setFont('helvetica', 'italic');
  doc.setFontSize(9);
  const wordsLines = doc.splitTextToSize(`Amount in Words: ${invoice.amountInWords || amountInWords(invoice.total)}`, 180);
  doc.text(wordsLines, PAGE_MARGIN, y);
  y += wordsLines.length * 5 + 6;

  const pageHeight = doc.internal.pageSize.getHeight();
  if (y > pageHeight - 55) {
    doc.addPage();
    y = 20;
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

  const includeSeal = invoice.includeSeal !== false;
  const includeSignatory = invoice.includeSignatory !== false;
  const sealX = pageWidth - PAGE_MARGIN - 45;
  const sealY = y;
  const sealAreaHeight = 20;
  const forNameY = sealY - 3;
  const signatoryY = sealY + sealAreaHeight + 4;

  if (includeSignatory) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(0);
    doc.text(`For ${profile.name || 'Business Name'}`, sealX + 20, forNameY, { align: 'center' });
  }

  if (includeSeal) {
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

  if (includeSignatory) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(0);
    doc.text('Authorized Signatory', sealX + 20, signatoryY, { align: 'center' });
  }

  drawFooter(doc, profile);
  return doc;
}
