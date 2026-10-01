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

// ---- gravação segura: dois lados gravando ao mesmo tempo ----
// Servidor falso com "versão" por documento e precondição, como o Firestore.
function servidor(inicial){
  const s = { dados: JSON.parse(JSON.stringify(inicial)), versao: 1, gravacoes: 0 };
  s.ler = async () => ({ ok:true, records: JSON.parse(JSON.stringify(s.dados)), version: s.versao });
  s.escrever = async (obj, v) => {
    if(v !== undefined && v !== s.versao) return { ok:false, conflito:true };
    s.dados = JSON.parse(JSON.stringify(obj)); s.versao++; s.gravacoes++;
    return { ok:true };
  };
  return s;
}
const clone = o => JSON.parse(JSON.stringify(o));

test('mesclar: aplica só os dias que este lado mexeu', () => {
  const base   = { [seg]: dia('08:00','12:00','13:00','17:00') };
  const mine   = { [seg]: dia('08:00','12:00','13:00','17:00'), [ter]: dia('08:00',null,null,null) };  // bati o ponto na terça
  const latest = { [seg]: dia('08:00','12:00','13:00','17:00'), '2026-09-09': { abono:{ motivo:'atestado' } } }; // ADM abonou outro dia
  const r = C.mesclarRecordsPorDia(base, mine, latest);
  assert.deepEqual(Object.keys(r).sort(), [seg, ter, '2026-09-09'].sort());
  assert.deepEqual(r['2026-09-09'], { abono:{ motivo:'atestado' } });
  assert.equal(r[ter].entrada, '08:00');
});

test('mesclar: excluir um dia só apaga esse dia', () => {
  const base = { [seg]: dia('08:00','12:00','13:00','17:00'), [ter]: { falta:true } };
  const mine = { [ter]: { falta:true } };
  const latest = { [seg]: dia('08:00','12:00','13:00','17:00'), [ter]: { falta:true }, '2026-09-10': { falta:true } };
  assert.deepEqual(Object.keys(C.mesclarRecordsPorDia(base, mine, latest)).sort(), [ter, '2026-09-10'].sort());
});

test('BUG ANTIGO: o funcionário grava com dados velhos e apagava o abono que o ADM acabou de marcar', async () => {
  const s = servidor({ [seg]: dia('08:00','12:00','13:00','17:00') });
  const base = clone(s.dados);                       // o app do funcionário leu isto
  s.dados['2026-09-09'] = { abono:{ motivo:'atestado' } }; s.versao++;   // ADM abona um dia depois
  const mine = clone(base); mine[ter] = dia('08:00',null,null,null);     // funcionário bate o ponto
  const r = await C.gravarRecordsComMerge({ base, mine, ler: s.ler, escrever: s.escrever });
  assert.equal(r.ok, true);
  assert.ok(s.dados['2026-09-09'] && s.dados['2026-09-09'].abono, 'o abono do ADM tem que continuar lá');
  assert.equal(s.dados[ter].entrada, '08:00');
  assert.equal(r.mesclou, true);
});

test('conflito no meio da gravação: tenta de novo com a versão nova e não perde nada', async () => {
  const s = servidor({ [seg]: dia('08:00','12:00','13:00','17:00') });
  const base = clone(s.dados), mine = clone(base); mine[ter] = dia('09:00',null,null,null);
  let primeira = true;
  const ler = async () => { const r = await s.ler(); if(primeira){ primeira = false;
      // depois da leitura e antes da escrita, o ADM grava
      s.dados['2026-09-09'] = { folga:{ minutosConvertidos: 60 } }; s.versao++; } return r; };
  const r = await C.gravarRecordsComMerge({ base, mine, ler, escrever: s.escrever });
  assert.equal(r.ok, true);
  assert.ok(s.dados['2026-09-09'].folga);
  assert.equal(s.dados[ter].entrada, '09:00');
});

test('conflito que nunca acaba: falha em vez de sobrescrever', async () => {
  const s = servidor({});
  const ler = async () => { const r = await s.ler(); s.versao++; return r; };   // sempre muda antes de gravar
  const r = await C.gravarRecordsComMerge({ base:{}, mine:{ [seg]: { falta:true } }, ler, escrever: s.escrever, tentativas: 3 });
  assert.equal(r.ok, false);
  assert.equal(r.motivo, 'conflito');
  assert.equal(s.gravacoes, 0);
});

test('releitura falhou: grava como antes (não fica pior)', async () => {
  const s = servidor({});
  const r = await C.gravarRecordsComMerge({ base:{}, mine:{ [seg]: { falta:true } }, ler: async()=>({ ok:false }), escrever: s.escrever });
  assert.equal(r.ok, true);
  assert.ok(s.dados[seg]);
});

test('erro de escrita que não é conflito não fica repetindo', async () => {
  let chamadas = 0;
  const r = await C.gravarRecordsComMerge({ base:{}, mine:{}, ler: async()=>({ ok:true, records:{}, version:1 }),
    escrever: async()=>{ chamadas++; return { ok:false, erro:'http 403' }; } });
  assert.equal(r.ok, false); assert.equal(chamadas, 1); assert.equal(r.erro, 'http 403');
});

test('classificar erro de escrita: conflito x parâmetro recusado x erro de verdade', () => {
  const c = C.classificarFalhaDeEscrita;
  assert.deepEqual(c(400, 'FAILED_PRECONDITION', true), { conflito:true,  semPrecondicao:false });
  assert.deepEqual(c(409, 'ABORTED', true),             { conflito:true,  semPrecondicao:false });
  assert.deepEqual(c(404, 'NOT_FOUND', true),           { conflito:true,  semPrecondicao:false });  // documento apagado no meio
  assert.deepEqual(c(400, 'INVALID_ARGUMENT', true),    { conflito:false, semPrecondicao:true  });  // servidor não entendeu o parâmetro
  assert.deepEqual(c(403, 'PERMISSION_DENIED', true),   { conflito:false, semPrecondicao:false });
  assert.deepEqual(c(503, 'UNAVAILABLE', true),         { conflito:false, semPrecondicao:false });
  assert.deepEqual(c(400, 'FAILED_PRECONDITION', false),{ conflito:false, semPrecondicao:false });  // sem precondição não existe conflito
});

// ---- extrato da hora extra ----
test('extrato: gerada (dia a dia), usos (folga, saiu mais cedo, pago, abono) e total − usado = saldo', () => {
  const records = {
    '2026-08-31': dia('08:00','12:00','13:00','20:00'),                                       // ago: 5h extra
    '2026-09-01': dia('08:00','12:00','13:00','19:00'),                          // set: 4h extra
    '2026-09-02': dia('08:00','12:00','13:00','14:00', { complemento:{ minutos:60, motivo:'saiu cedo' } }),
    [sab]: dia('08:00','10:00','10:30','12:30'),                                              // sáb: 4h extra
    '2026-09-08': { abono:{ motivo:'atestado' } },
    '2026-09-09': { folga:{ minutosConvertidos:120, motivo:'compensação' } },
  };
  const extras = [{ id:'a', mes:'2026-09', minutos:90, valor:75.5, motivo:'pago', quando:'2026-09-15T15:00:00.000Z' },
                  { id:'b', mes:'2026-08', minutos:30, valor:20, motivo:'ago', quando:'2026-08-31T15:00:00.000Z' }];
  const m = C.movimentoHoraExtra(records, extras, '2026-09', clt6);
  assert.deepEqual(m.geradas.map(g=>[g.key, g.extraMins, g.fimDeSemana]), [['2026-09-01', 240, false], [sab, 240, true]]);
  assert.equal(m.geradaMesMins, 480);
  assert.deepEqual(m.usos.map(u=>[u.tipo, u.key, u.mins]),
    [['complemento','2026-09-02',60], ['abono','2026-09-08',0], ['folga','2026-09-09',120], ['dinheiro','2026-09-15',90]].sort((a,b)=>a[1].localeCompare(b[1])));
  assert.equal(m.usos.find(u=>u.tipo==='complemento').batidoMins, 300);          // bateu 5h e saiu mais cedo
  assert.equal(m.usadoMesMins, 60 + 120 + 90);                                   // abono não consome saldo
  assert.equal(m.acumulado.geradoMins, 780);                                      // 5h (ago) + 4h + 4h
  assert.equal(m.acumulado.usadoMins, 60 + 120 + 90 + 30);                        // + 30min pagos referentes a agosto
  assert.equal(m.acumulado.usadoOutrosMesesMins, 30);
  assert.equal(m.acumulado.saldoMins, 780 - 300);
  // a conta final é a mesma do saldo que todas as telas mostram
  assert.equal(m.acumulado.saldoMins, C.saldoHoraExtra(records, extras, clt6).saldoMins);
  assert.equal(m.acumulado.geradoMins - m.acumulado.usadoMins, m.acumulado.saldoMins);
});

test('extrato: complemento "deixar negativo" aparece marcado e o saldo pode ficar negativo', () => {
  const records = { '2026-09-02': dia('08:00','12:00','13:00','14:00', { complemento:{ minutos:60, motivo:'x', negativo:true } }) };
  const m = C.movimentoHoraExtra(records, [], '2026-09', clt6);
  assert.equal(m.usos[0].negativo, true);
  assert.equal(m.acumulado.saldoMins, -60);
});

test('extrato: mês sem nada devolve listas vazias e o saldo acumulado', () => {
  const m = C.movimentoHoraExtra({ '2026-08-31': dia('08:00','12:00','13:00','20:00') }, [], '2026-09', clt6);
  assert.deepEqual([m.geradas.length, m.usos.length, m.geradaMesMins, m.usadoMesMins], [0,0,0,0]);
  assert.equal(m.acumulado.saldoMins, 300);
});
