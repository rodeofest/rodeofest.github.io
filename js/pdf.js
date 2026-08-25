/* jsPDF document builders for Quotations and Invoices. Requires jsPDF + jspdf-autotable (loaded via CDN in index.html). */

const PAGE_MARGIN = 14;

function fmtMoney(n) {
  return 'Rs. ' + (Number(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

function drawHeader(doc, profile, docTitle, docNo, docDate, company) {
  let y = 16;
  const pageWidth = doc.internal.pageSize.getWidth();

  if (profile.logoDataUrl) {
    try {
      doc.addImage(profile.logoDataUrl, 'PNG', PAGE_MARGIN, 10, 24, 24);
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
  doc.text(docTitle, pageWidth - PAGE_MARGIN, 16, { align: 'right' });
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.text(`No: ${docNo}`, pageWidth - PAGE_MARGIN, 23, { align: 'right' });
  doc.text(`Date: ${fmtDate(docDate)}`, pageWidth - PAGE_MARGIN, 28, { align: 'right' });

  y = Math.max(y, 36) + 4;
  doc.setDrawColor(180);
  doc.line(PAGE_MARGIN, y, pageWidth - PAGE_MARGIN, y);
  y += 7;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.text('Bill To:', PAGE_MARGIN, y);
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

function buildItemRows(items) {
  return items.map((it, idx) => {
    const taxable = (Number(it.qty) || 0) * (Number(it.rate) || 0);
    const tax = taxable * (Number(it.gstPercent) || 0) / 100;
    const productCell = it.details ? `${it.name}\n${it.details}` : it.name;
    return [
      String(idx + 1),
      productCell,
      it.hsnCode || '',
      `${it.qty} ${it.unit || ''}`.trim(),
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
  const tableStartY = drawHeader(doc, profile, 'QUOTATION', quotation.quotationNo, quotation.date, company);

  doc.autoTable({
    startY: tableStartY,
    head: [['#', 'Product', 'HSN', 'Qty', 'Rate', 'GST%', 'Tax', 'Total']],
    body: buildItemRows(quotation.items),
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
  const tableStartY = drawHeader(doc, profile, 'TAX INVOICE', invoice.invoiceNo, invoice.date, company);

  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  doc.text(`Challan No: ${invoice.challanNo || '-'}`, PAGE_MARGIN, tableStartY - 2);

  doc.autoTable({
    startY: tableStartY + 3,
    head: [['#', 'Product', 'HSN', 'Qty', 'Rate', 'GST%', 'Tax', 'Total']],
    body: buildItemRows(invoice.items),
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

  const sealX = pageWidth - PAGE_MARGIN - 45;
  const sealY = y - 5;
  if (profile.sealDataUrl) {
    try {
      doc.addImage(profile.sealDataUrl, 'PNG', sealX, sealY, 40, 40);
    } catch (e) { /* ignore */ }
  } else {
    doc.setDrawColor(180);
    doc.rect(sealX, sealY, 40, 25);
    doc.setFontSize(8);
    doc.setTextColor(150);
    doc.text('Company Seal', sealX + 20, sealY + 13, { align: 'center' });
    doc.setTextColor(0);
  }

  drawFooter(doc, profile);
  return doc;
}
