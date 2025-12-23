// src/utils/ArgentinaTime.ts
/**
 * Devuelve la fecha y hora actual en GMT-3 (hora argentina) en formato 'YYYY-MM-DD HH:mm'.
 */
export function getArgentinaDatetimeString(): string {
    const nowUtc = new Date(Date.now());
    const gmt3 = new Date(nowUtc.getTime() - 3 * 60 * 60 * 1000);
    const yyyy = gmt3.getUTCFullYear();
    const mm = String(gmt3.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(gmt3.getUTCDate()).padStart(2, '0');
    const hh = String(gmt3.getUTCHours()).padStart(2, '0');
    const min = String(gmt3.getUTCMinutes()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
}
