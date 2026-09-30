// Rodar com: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../ponto-core.js');

// 2026-09: dia 1 = terça. 5 = sábado, 6 = domingo.
const seg = '2026-09-07', ter = '2026-09-08', sab = '2026-09-05', dom = '2026-09-06';
const clt6 = { jornadaPadraoMin: 360 };
const clt8 = { jornadaPadraoMin: 480 };
const dia = (entrada, almocoSaida, almocoVolta, saida, extra) => Object.assign({ entrada, almocoSaida, almocoVolta, saida }, extra);

test('hora extra acima da jornada do funcionário (não fixa em 6h)', () => {
  const rec = dia('08:00', '12:00', '13:00', '18:00'); // 4h + 5h = 9h
  assert.equal(C.calcDia(rec, seg, clt6).extraMins, 3*60);
  assert.equal(C.calcDia(rec, seg, clt8).extraMins, 60);
  assert.equal(C.calcDia(rec, seg, null).extraMins, 3*60); // sem cadastro -> 6h
});

test('fim de semana: tudo é hora extra, inclusive diarista', () => {
  assert.equal(C.calcDia(dia('08:00', '10:00', '10:30', '12:00'), sab, clt8).extraMins, 3.5*60);
  assert.equal(C.calcDia({ diarista:true, entrada:'08:00', saida:'12:00' }, dom, null).extraMins, 4*60);
  assert.equal(C.calcDia({ diarista:true, entrada:'08:00', saida:'12:00' }, seg, null).extraMins, 0);
});

test('falta, abono e folga não geram hora extra', () => {
  assert.equal(C.calcDia({ falta:true }, sab, clt6).extraMins, 0);
  assert.equal(C.calcDia({ abono:{} }, seg, clt6).extraMins, 0);
  assert.equal(C.calcDia({ folga:{ minutosConvertidos: 120 } }, seg, clt6).extraMins, 0);
});

test('BUG ANTIGO: complemento de jornada sai do saldo (ADM já descontava, ponto não)', () => {
  const records = {
    [seg]: dia('08:00', '12:00', '13:00', '19:00'),                       // 4h+6h = 10h -> 4h extra
    [ter]: dia('08:00', '12:00', '13:00', '14:00', { complemento:{ minutos: 60, motivo:'x' } }) // 5h batidas + 1h de complemento
  };
  const s = C.saldoHoraExtra(records, [], clt6);
  assert.equal(s.totalExtraMins, 4*60);
  assert.equal(s.complementoMins, 60);
  assert.equal(s.saldoMins, 3*60);      // antes o ponto mostrava 4h00
});

test('complemento conta como hora trabalhada do dia, mas não gera extra', () => {
  const t = C.calcDia(dia('08:00', '12:00', '13:00', '14:00', { complemento:{ minutos: 60 } }), ter, clt6);
  assert.equal(t.mins, 5*60);
  assert.equal(t.totalMins, 6*60);
  assert.equal(t.extraMins, 0);
});

test('saldo desconta folga (novo e antigo formato), complemento e extra paga em dinheiro', () => {
  const records = {
    [seg]: dia('08:00', '12:00', '13:00', '21:00'), // 4h + 8h = 12h -> 6h extra
    [ter]: dia('08:00', '12:00', '13:00', '21:00'), // +6h -> 12h no total
    '2026-09-09': { folga:{ minutosConvertidos: 90 } },
    '2026-09-10': { folga:{ horasConvertidas: 0.5 } }
  };
  const extras = [{ id:'a', mes:'2026-09', minutos: 60, valor: 50 }, { id:'b', mes:'2026-09', horas: 1.5, valor: 80 }];
  const s = C.saldoHoraExtra(records, extras, clt6);
  assert.equal(s.totalExtraMins, 12*60);
  assert.equal(s.folgaMins, 90 + 30);
  assert.equal(s.pagoMins, 60 + 90);
  assert.equal(s.saldoMins, 12*60 - 120 - 150);
});

test('resumo do mês: horas, extra, faltantes e extras pagas', () => {
  const records = {
    [seg]: dia('08:00', '12:00', '13:00', '19:00'),
    [ter]: dia('08:00', '12:00', '13:00', '14:00', { complemento:{ minutos: 60 } }),
    '2026-09-09': { abono:{ motivo:'x' } }
  };
  const extras = [{ id:'a', mes:'2026-09', minutos: 60, valor: 50 }, { id:'z', mes:'2026-08', minutos: 30, valor: 10 }];
  const r = C.resumoHorasMes(records, '2026-09', clt6, extras);
  assert.equal(r.diasUteis, 22);
  assert.equal(r.batidosMesMins, 10*60 + 5*60);
  assert.equal(r.complementoMesMins, 60);
  assert.equal(r.totalMesMins, 16*60);
  assert.equal(r.extraMesMins, 4*60);
  assert.equal(r.horasFaltantesMin, 22*360 - (16*60 + 360)); // abono conta como jornada cumprida
  assert.equal(r.extrasPagasMins, 60);
  assert.equal(r.extrasPagasValor, 50);
});

test('dias incompletos ignoram fim de semana, complemento e dia aceito', () => {
  const records = {
    [seg]: dia('08:00', '12:00', '13:00', '14:00'),                                  // 5h -> incompleto
    [ter]: dia('08:00', '12:00', '13:00', '14:00', { complemento:{ minutos: 60 } }),  // resolvido
    '2026-09-09': dia('08:00', '12:00', '13:00', '14:00', { diaResolvido:{ motivo:'ok' } }),
    [sab]: dia('08:00', '10:00', '10:30', '11:00')                                     // fim de semana
  };
  const inc = C.diasIncompletosDoMes(records, '2026-09', 360);
  assert.deepEqual(inc.map(i=>i.key), [seg]);
  assert.equal(inc[0].faltam, 60);
});

test('datas locais: virada de mês não usa UTC', () => {
  const d = new Date(2026, 8, 30, 23, 30); // 30/09 23:30 no fuso do aparelho
  assert.equal(C.dateKeyOf(d), '2026-09-30');
  assert.equal(C.shiftMonth('2026-12', 1), '2027-01');
  assert.equal(C.shiftMonth('2026-01', -1), '2025-12');
});

test('batida incoerente (saída antes da entrada) nunca gera hora extra negativa', () => {
  const rec = dia('20:00', '16:00', '01:00', '04:00'); // minutos negativos
  assert.equal(C.calcDia(rec, sab, clt6).extraMins, 0);
  assert.equal(C.calcDia(rec, seg, clt6).extraMins, 0);
  assert.equal(C.saldoHoraExtra({ [sab]: rec }, [], clt6).saldoMins, 0);
});

test('formatMinutes', () => {
  assert.equal(C.formatMinutes(0), '0h00');
  assert.equal(C.formatMinutes(75), '1h15');
  assert.equal(C.formatMinutes(59.6), '1h00');
  assert.equal(C.formatMinutes(-90), '-1h30');
});
