// Phase B logic: multi-session hours, shift clamping, lunch, grading.
// Pure functions, no database.
const path = require('path');
const S = require(path.join(__dirname, '..', 'src', 'utils', 'shift_status'));

let pass = 0, fail = 0;
const ok = (n, c, extra = '') => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n}  ${extra}`); } };
const H = (ms) => (ms / 3600000).toFixed(2) + 'h';
const D = '2026-09-11';
const at = (hhmm) => new Date(`${D}T${hhmm}:00`);
const shift = { startTime: '09:00', endTime: '18:00' };
const settings = { attendance: { minLunch: 60, lateGrace: 15 } };

console.log('\n— openSessionIndex: must check BOTH root and shifts[] —');
ok('root punch open', S.openSessionIndex({ punchIn: at('09:00') }) === 0);
ok('root punch closed', S.openSessionIndex({ punchIn: at('09:00'), punchOut: at('18:00') }) === -1);
ok('shifts[] last open', S.openSessionIndex({ shifts: [{ punchIn: at('09:00'), punchOut: at('13:00') }, { punchIn: at('14:00') }] }) === 1);
ok('all shifts closed', S.openSessionIndex({ shifts: [{ punchIn: at('09:00'), punchOut: at('18:00') }] }) === -1);
ok('no punches at all', S.openSessionIndex({}) === -1);

console.log('\n— computeWorkedMs: clamped to the shift window —');
{
  const a = { date: D, shifts: [{ punchIn: at('09:00'), punchOut: at('18:00') }] };
  ok('full 9h shift minus 1h lunch = 8h', S.computeWorkedMs(a, shift, settings) === 8 * 3600000, H(S.computeWorkedMs(a, shift, settings)));
}
{
  // Early in, late out: neither should be paid as worked time.
  const a = { date: D, shifts: [{ punchIn: at('07:00'), punchOut: at('21:00') }] };
  ok('07:00-21:00 clamps to 9h, minus lunch = 8h', S.computeWorkedMs(a, shift, settings) === 8 * 3600000, H(S.computeWorkedMs(a, shift, settings)));
}
{
  // Three sessions summing to 8h inside the window.
  const a = { date: D, shifts: [
    { punchIn: at('09:00'), punchOut: at('12:00') },
    { punchIn: at('13:00'), punchOut: at('16:00') },
    { punchIn: at('16:00'), punchOut: at('18:00') },
  ]};
  ok('3 sessions = 8h worked, minus lunch = 7h', S.computeWorkedMs(a, shift, settings) === 7 * 3600000, H(S.computeWorkedMs(a, shift, settings)));
}
{
  const a = { date: D, shifts: [{ punchIn: at('09:00'), punchOut: at('18:00') }] };
  ok('no shift = no clamping (9h, minus lunch = 8h)', S.computeWorkedMs(a, null, settings) === 8 * 3600000, H(S.computeWorkedMs(a, null, settings)));
  ok('open session contributes 0', S.computeWorkedMs({ date: D, shifts: [{ punchIn: at('09:00') }] }, shift, settings) === 0);
}

console.log('\n— lunch deduction rules —');
{
  const base = { date: D, shifts: [{ punchIn: at('09:00'), punchOut: at('18:00') }] };
  // Shorter lunch than configured still costs the configured minimum.
  const short = { ...base, lunchInTime: at('13:00'), lunchOutTime: at('13:20') };
  ok('20m lunch still costs the configured 60m', S.computeWorkedMs(short, shift, settings) === 8 * 3600000, H(S.computeWorkedMs(short, shift, settings)));
  // Longer lunch costs its real length.
  const long = { ...base, lunchInTime: at('13:00'), lunchOutTime: at('15:00') };
  ok('2h lunch costs the full 2h', S.computeWorkedMs(long, shift, settings) === 7 * 3600000, H(S.computeWorkedMs(long, shift, settings)));
  // deductLunch:false turns it off entirely.
  const off = { attendance: { minLunch: 60, halfDayRules: { deductLunch: false } } };
  ok('deductLunch:false -> no deduction', S.computeWorkedMs(long, shift, off) === 9 * 3600000, H(S.computeWorkedMs(long, shift, off)));
}

console.log('\n— requiredWorkMs: the calibration trap —');
{
  const req = S.requiredWorkMs(shift, settings);
  // 9h span - 1h lunch - 15m grace = 7h45
  ok('9h shift, 1h lunch, 15m grace -> 7h45', req === 7.75 * 3600000, H(req));
  ok('Full Day is REACHABLE by someone present all shift', 8 * 3600000 >= req, 'worked 8h vs required ' + H(req));
  // Misconfigured shift: lunch >= span. Floor applies HERE only.
  const tiny = { startTime: '09:00', endTime: '09:30' };
  const r2 = S.requiredWorkMs(tiny, settings);
  ok('misconfigured shift floors at <=30m', r2 <= 30 * 60000 && r2 > 0, H(r2));
  // A genuinely short shift must still be gradeable, not floored out of reach.
  const shortShift = { startTime: '09:00', endTime: '09:40' };
  const r3 = S.requiredWorkMs(shortShift, { attendance: { minLunch: 0, lateGrace: 0 } });
  ok('40m shift with no lunch requires 40m (not floored)', r3 === 40 * 60000, H(r3));
  ok('no shift -> null (cannot grade on hours)', S.requiredWorkMs(null, settings) === null);
}

console.log('\n— gradeDay —');
{
  const full = { date: D, shifts: [{ punchIn: at('09:00'), punchOut: at('18:00') }] };
  ok('present all shift -> present', S.gradeDay(full, shift, settings) === 'present', String(S.gradeDay(full, shift, settings)));
  const half = { date: D, shifts: [{ punchIn: at('09:00'), punchOut: at('13:00') }] };
  ok('4h worked -> half-day', S.gradeDay(half, shift, settings) === 'half-day', String(S.gradeDay(half, shift, settings)));
  ok('day still open -> null (never guess)', S.gradeDay({ date: D, shifts: [{ punchIn: at('09:00') }] }, shift, settings) === null);
  const zero = { date: D, shifts: [{ punchIn: at('19:00'), punchOut: at('20:00') }] };
  ok('worked entirely outside shift -> absent', S.gradeDay(zero, shift, settings) === 'absent', String(S.gradeDay(zero, shift, settings)));
}

console.log('\n— overnight shift —');
{
  const night = { startTime: '22:00', endTime: '06:00' };
  const a = { date: D, shifts: [{ punchIn: at('22:00'), punchOut: new Date(`2026-09-12T06:00:00`) }] };
  const w = S.computeWorkedMs(a, night, { attendance: { minLunch: 0 } });
  ok('22:00-06:00 counts 8h', w === 8 * 3600000, H(w));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
