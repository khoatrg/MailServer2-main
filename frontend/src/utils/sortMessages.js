export function sortMessages(messages, field = 'date', dir = 'desc') {
  if (!Array.isArray(messages)) return [];
  const copy = messages.slice();
  copy.sort((a, b) => {
    let va = (a && a[field]) || '';
    let vb = (b && b[field]) || '';

    // if sorting by date, parse to timestamp
    if (field === 'date') {
      const ta = va ? Date.parse(va) : NaN;
      const tb = vb ? Date.parse(vb) : NaN;
      // treat invalid dates as very old
      const na = isNaN(ta) ? -8640000000000000 : ta;
      const nb = isNaN(tb) ? -8640000000000000 : tb;
      if (na === nb) return 0;
      return dir === 'asc' ? (na - nb) : (nb - na);
    }

    // fallback: string compare
    va = String(va).toLowerCase();
    vb = String(vb).toLowerCase();
    if (va === vb) return 0;
    return dir === 'asc' ? (va < vb ? -1 : 1) : (va < vb ? 1 : -1);
  });
  return copy;
}

export function sortByDate(messages, dir = 'desc') {
  return sortMessages(messages, 'date', dir);
}