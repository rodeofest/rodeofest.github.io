/* Converts a number into Indian-style (lakh/crore) words, for invoice amounts. */

const NW_ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
  'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const NW_TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function twoDigitsToWords(n) {
  if (n < 20) return NW_ONES[n];
  const tens = Math.floor(n / 10);
  const ones = n % 10;
  return NW_TENS[tens] + (ones ? ' ' + NW_ONES[ones] : '');
}

function threeDigitsToWords(n) {
  const hundred = Math.floor(n / 100);
  const rest = n % 100;
  let out = '';
  if (hundred) out += NW_ONES[hundred] + ' Hundred';
  if (rest) out += (out ? ' ' : '') + twoDigitsToWords(rest);
  return out;
}

function integerToIndianWords(num) {
  if (num === 0) return 'Zero';
  const crore = Math.floor(num / 10000000);
  num %= 10000000;
  const lakh = Math.floor(num / 100000);
  num %= 100000;
  const thousand = Math.floor(num / 1000);
  num %= 1000;
  const hundred = num;

  const parts = [];
  if (crore) parts.push(threeDigitsToWords(crore) + ' Crore');
  if (lakh) parts.push(twoDigitsToWords(lakh) + ' Lakh');
  if (thousand) parts.push(twoDigitsToWords(thousand) + ' Thousand');
  if (hundred) parts.push(threeDigitsToWords(hundred));
  return parts.join(' ');
}

function amountInWords(amount) {
  const rupees = Math.floor(amount);
  const paise = Math.round((amount - rupees) * 100);
  let words = 'Rupees ' + integerToIndianWords(rupees);
  if (paise > 0) {
    words += ' and ' + twoDigitsToWords(paise) + ' Paise';
  }
  return words + ' Only';
}
