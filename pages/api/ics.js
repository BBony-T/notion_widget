// /api/ics.js  — iCal(ICS) → JSON 프록시 (Vercel 서버리스)
// - 사용법(환경변수로 ICS 설정):  /api/ics?timeMin=...&timeMax=...&maxResults=100
// - 사용법(URL로 ICS 전달):      /api/ics?ics=https%3A%2F%2Fcalendar.google.com%2Fcalendar%2Fical%2F...basic.ics&timeMin=...&timeMax=...
//   (보안을 위해 가능하면 ICS_URL 환경변수를 쓰세요)

function parseICS(text) {
  // 매우 가벼운 ICS 파서 (VEVENT만)
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const items = [];
  let cur = null;

  const flush = () => { if (cur) { items.push(cur); cur = null; } };

  // unfold (접힌 줄 이어 붙이기)
  for (let i = 1; i < lines.length; i++) {
    if (/^[ \t]/.test(lines[i])) {
      lines[i - 1] += lines[i].slice(1);
      lines.splice(i, 1);
      i--;
    }
  }

  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') {
      cur = { raw: {} };
    } else if (line === 'END:VEVENT') {
      if (cur) {
        // Google-like JSON으로 정규화
        const allDay = !cur.DTSTART || /^\d{8}$/.test(cur.DTSTART.value);
        const toISO = (v) => {
          if (!v) return null;
          // 날짜만 있는 종일(YYYYMMDD) → 00:00:00Z로
          if (/^\d{8}$/.test(v)) {
            const y = v.slice(0, 4), m = v.slice(4, 6), d = v.slice(6, 8);
            return new Date(Date.UTC(+y, +m - 1, +d)).toISOString();
          }
          // YYYYMMDDTHHMMSSZ / 또는 TZ 없는 로컬 → 그대로 Date 처리
          const z = v.endsWith('Z') ? v : v + 'Z';
          // 일부 ICS는 TZID 파라미터를 가질 수 있으나 단순화
          return new Date(z.replace(/(?<!Z)$/, '')).toISOString();
        };

        const startISO = toISO(cur.DTSTART?.value);
        const endISO   = toISO(cur.DTEND?.value) || startISO;

        const item = {
          summary: cur.SUMMARY?.value || '(제목 없음)',
          location: cur.LOCATION?.value || '',
          description: cur.DESCRIPTION?.value || '',
          htmlLink: cur.URL?.value || '',          // 있을 때만
          start: allDay ? { date: startISO?.slice(0, 10) } : { dateTime: startISO },
          end:   allDay ? { date: endISO?.slice(0, 10) }   : { dateTime: endISO  },
          // ICS에는 colorId가 없어서 생략 (위젯에서는 키워드/맵으로 색상 매핑)
        };
        items.push(item);
      }
      cur = null;
    } else if (cur) {
      const idx = line.indexOf(':');
      if (idx > -1) {
        const keyAndParams = line.slice(0, idx);
        const value = line.slice(idx + 1);
        const [key/*, ...params*/] = keyAndParams.split(';');
        const K = key.toUpperCase();
        cur[K] = { value };
      }
    }
  }
  return items;
}

export default async function handler(req, res) {
  try {
    const { ics, timeMin, timeMax, maxResults = 200 } = req.query;

    // ICS URL 결정: 쿼리로 오면 그걸, 아니면 환경변수
    let icsUrl = ics || process.env.ICS_URL;
    if (!icsUrl) {
      return res.status(400).json({ error: 'Missing ICS URL. Pass ?ics=<url> or set env ICS_URL.' });
    }

    // 간단한 안전장치 (https만, 최대 길이 제한)
    if (!/^https:\/\//i.test(icsUrl) || icsUrl.length > 1000) {
      return res.status(400).json({ error: 'Invalid ICS URL' });
    }

    // 가져오기
    const r = await fetch(icsUrl, { headers: { 'Accept': 'text/calendar' } });
    const text = await r.text();
    if (!r.ok) return res.status(r.status).json({ error: 'Fetch failed', detail: text });

    const all = parseICS(text);

    // 기간 필터 (옵션)
    const minT = timeMin ? new Date(timeMin).getTime() : null;
    const maxT = timeMax ? new Date(timeMax).getTime() : null;

    const toTs = (ev) => new Date(ev.start.dateTime || ev.start.date).getTime();
    let items = all.filter(ev => {
      const t = toTs(ev);
      if (Number.isFinite(minT) && t < minT) return false;
      if (Number.isFinite(maxT) && t > maxT) return false;
      return true;
    });

    items.sort((a, b) => toTs(a) - toTs(b));
    items = items.slice(0, parseInt(maxResults, 10) || 200);

    // CORS + 캐시
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=600');

    // 위젯이 기대하는 형태 { items: [...] }
    return res.status(200).json({ items });
  } catch (e) {
    return res.status(500).json({ error: 'ICS proxy failure', detail: String(e) });
  }
}
