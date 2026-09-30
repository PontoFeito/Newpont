/* ponto-core.js — regra ÚNICA de horas trabalhadas e hora extra.
 *
 * É carregado pelos três sites que leem o mesmo Firestore:
 *   - app do funcionário  (controle_de_ponto.html)   \  repositório Newpont
 *   - painel do ADM       (admin.html)               /
 *   - folha de pagamentos (index.html)                  repositório Admin-pagamentos
 *
 * Antes cada página tinha a sua própria cópia dessas contas e elas foram se
 * afastando (ex.: o ADM descontava o "complemento de jornada" do saldo de
 * hora extra e o app do funcionário não; a folha usava sempre 6h e ignorava a
 * hora extra paga em dinheiro). Agora tudo passa por aqui.
 *
 * O arquivo é idêntico nos dois repositórios — se mudar um, copie pro outro.
 *
 * Modelo de dados (users/{uid}/appdata/ponto-records, um objeto por data):
 *   { entrada, almocoSaida, almocoVolta, saida, falta, diarista,
 *     abono:{motivo,valorDia?}, folga:{minutosConvertidos,motivo,valorDia?},
 *     complemento:{minutos,motivo,negativo?}, diaResolvido:{motivo} }
 * e ponto-extras-pagos: [{ id, mes:'YYYY-MM', minutos, valor, motivo }].
 *
 * Regras:
 *   - falta / abono / folga não têm horário batido e não geram hora extra;
 *   - sábado e domingo: tudo que foi trabalhado conta como hora extra;
 *   - dia útil: hora extra = minutos batidos acima da jornada do funcionário
 *     (employee.jornadaPadraoMin, padrão 6h);
 *   - complemento de jornada: o ADM cobre a diferença de um dia curto com o
 *     saldo. Conta como hora trabalhada naquele dia e sai do saldo — mas
 *     nunca gera hora extra por si só;
 *   - saldo = extra gerada − folgas − complementos − extras pagas em dinheiro.
 *
 * Gravação segura de ponto-records (gravarRecordsComMerge): o app do
 * funcionário e o ADM gravam o objeto INTEIRO dos pontos. Sem cuidado, quem
 * grava por último apaga a mudança do outro (ex.: o ADM abona um dia enquanto
 * o funcionário bate o ponto). Por isso a gravação relê o que está no servidor,
 * aplica por cima só os dias que ESTE lado mexeu e grava com a "versão" lida —
 * se alguém gravou no meio, o servidor recusa e o ciclo recomeça.
 */
(function(root, factory){
  if(typeof module === 'object' && module.exports) module.exports = factory();
  else root.PontoCore = factory();
})(typeof self !== 'undefined' ? self : this, function(){
  'use strict';

  const JORNADA_PADRAO_MIN_DEFAULT = 6*60;

  function pad(n){ return String(n).padStart(2,'0'); }

  // --- datas (sempre no fuso do aparelho: o app do funcionário grava a data
  // local, então o ADM e a folha precisam ler a data local também — usar
  // toISOString() aqui vira "amanhã" depois das 21h no Brasil) ---
  function dateKeyOf(d){ return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate()); }
  function todayKey(){ return dateKeyOf(new Date()); }
  function currentMonthKey(){ return todayKey().slice(0,7); }
  function monthKeyOf(dateKey){ return String(dateKey).slice(0,7); }
  function shiftMonth(mk, delta){
    let [y,m] = mk.split('-').map(Number);
    m += delta; if(m<1){m=12;y-=1;} else if(m>12){m=1;y+=1;}
    return `${y}-${pad(m)}`;
  }
  function dowOf(dateKey){
    const [y,m,d] = dateKey.split('-').map(Number);
    return new Date(y, m-1, d).getDay(); // 0=domingo ... 6=sábado
  }
  function isFimDeSemana(dateKey){ const d = dowOf(dateKey); return d===0 || d===6; }
  function isDiaUtil(dateKey){ const d = dowOf(dateKey); return d>=1 && d<=5; }
  function diasUteisNoMes(mk){
    const [y,m] = mk.split('-').map(Number);
    const diasNoMes = new Date(y, m, 0).getDate();
    let count = 0;
    for(let d=1; d<=diasNoMes; d++){
      const dow = new Date(y, m-1, d).getDay();
      if(dow>=1 && dow<=5) count++;
    }
    return count;
  }

  // --- horas ---
  function timeToMinutes(t){
    if(!t) return null;
    const [h,m] = String(t).split(':').map(Number);
    if(isNaN(h) || isNaN(m)) return null;
    return h*60+m;
  }
  function formatMinutes(mins){
    mins = Math.round(mins || 0);
    const sinal = mins<0 ? '-' : '';
    mins = Math.abs(mins);
    return `${sinal}${Math.floor(mins/60)}h${pad(mins%60)}`;
  }
  function jornadaPadraoDoEmployee(e){
    const v = e && e.jornadaPadraoMin;
    return (v && v>0) ? v : JORNADA_PADRAO_MIN_DEFAULT;
  }

  // Minutos efetivamente batidos (sem diarista, sem complemento).
  function minutosBatidos(rec){
    if(!rec) return { mins:0, complete:false };
    const e = timeToMinutes(rec.entrada), as = timeToMinutes(rec.almocoSaida),
          av = timeToMinutes(rec.almocoVolta), s = timeToMinutes(rec.saida);
    let mins = 0, complete = true;
    if(e!==null && as!==null){ mins += (as-e); } else complete = false;
    if(av!==null && s!==null){ mins += (s-av); } else complete = false;
    return { mins, complete };
  }

  // Consumo de saldo em minutos — aceita o formato novo (minutos inteiros) e o
  // antigo (horas em decimal), sempre arredondado pra nunca gerar dízima.
  function folgaMinutosConsumidos(folga){
    if(!folga) return 0;
    if(folga.minutosConvertidos!=null) return Math.round(Number(folga.minutosConvertidos)||0);
    return Math.round((Number(folga.horasConvertidas)||0)*60);
  }
  function complementoMinutosConsumidos(c){
    if(!c) return 0;
    return Math.round(Number(c.minutos)||0);
  }
  function extraMinutosConsumidos(x){
    if(!x) return 0;
    if(x.minutos!=null) return Math.round(Number(x.minutos)||0);
    return Math.round((Number(x.horas)||0)*60);
  }

  // Resultado de UM dia. `mins` são só os minutos batidos; `totalMins` inclui o
  // complemento (é o que aparece como "horas trabalhadas" em todos os sites).
  // Retorna null quando não há o que calcular ainda (dia sem horários).
  function calcDia(rec, dateKey, employee){
    if(!rec) return null;
    const zero = { mins:0, compMins:0, totalMins:0, complete:true, extraMins:0, normalMins:0 };
    if(rec.falta)  return Object.assign({ falta:true },  zero);
    if(rec.abono)  return Object.assign({ abono:true },  zero);
    if(rec.folga)  return Object.assign({ folga:true },  zero);
    const fimDeSemana = dateKey ? isFimDeSemana(dateKey) : false;
    if(rec.diarista){
      const e = timeToMinutes(rec.entrada), s = timeToMinutes(rec.saida);
      if(e===null || s===null) return null;
      const mins = Math.max(0, s-e);
      return { mins, compMins:0, totalMins:mins, complete:true,
               extraMins: fimDeSemana ? mins : 0, normalMins: fimDeSemana ? 0 : mins, diarista:true };
    }
    const { mins, complete } = minutosBatidos(rec);
    if(mins<=0 && !complete) return null;
    const jornada = jornadaPadraoDoEmployee(employee);
    // Batida incoerente (saída antes da entrada) dá minutos negativos: nunca
    // vira hora extra negativa no saldo (o ADM já tratava assim, o ponto não).
    const extraMins = Math.max(0, fimDeSemana ? mins : (mins > jornada ? mins - jornada : 0));
    const compMins = complementoMinutosConsumidos(rec.complemento);
    return { mins, compMins, totalMins: mins + compMins, complete, extraMins, normalMins: mins - extraMins };
  }

  // Saldo de hora extra acumulado (todos os meses).
  function saldoHoraExtra(records, extrasPagos, employee){
    let totalExtraMins = 0, folgaMins = 0, complementoMins = 0, pagoMins = 0;
    Object.keys(records || {}).forEach(k=>{
      const rec = records[k];
      if(!rec) return;
      const t = calcDia(rec, k, employee);
      if(t && !t.falta) totalExtraMins += Math.round(t.extraMins || 0);
      folgaMins += folgaMinutosConsumidos(rec.folga);
      complementoMins += complementoMinutosConsumidos(rec.complemento);
    });
    (extrasPagos || []).forEach(x=>{ pagoMins += extraMinutosConsumidos(x); });
    const usadoMins = folgaMins + complementoMins + pagoMins;
    return { totalExtraMins, folgaMins, complementoMins, pagoMins, usadoMins,
             saldoMins: Math.round(totalExtraMins - usadoMins) };
  }

  // --- contagens do mês (usadas pelo salário proporcional, VA e VT) ---
  function keysDoMes(records, mk){ return Object.keys(records || {}).filter(k=>monthKeyOf(k)===mk && records[k]); }
  function diasTrabalhadosNoMes(records, mk){ return keysDoMes(records, mk).filter(k=>records[k].entrada && !records[k].falta).length; }
  function diasAbonoNoMes(records, mk){ return keysDoMes(records, mk).filter(k=>records[k].abono).length; }
  function diasFolgaNoMes(records, mk){ return keysDoMes(records, mk).filter(k=>records[k].folga).length; }
  function faltasNoMes(records, mk){ return keysDoMes(records, mk).filter(k=>records[k].falta).length; }

  // Dias úteis com batida real, mas abaixo da jornada, que ninguém resolveu
  // ainda (nem complementou, nem aceitou assim mesmo).
  function diasIncompletosDoMes(records, mk, jornadaMin){
    const incompletos = [];
    keysDoMes(records, mk).forEach(k=>{
      const rec = records[k];
      if(rec.falta || rec.abono || rec.folga || rec.diarista || rec.complemento || rec.diaResolvido) return;
      if(!isDiaUtil(k)) return; // fim de semana não segue a jornada padrão
      const { mins } = minutosBatidos(rec);
      if(mins>0 && mins < jornadaMin) incompletos.push({ key:k, mins, faltam: jornadaMin - mins });
    });
    return incompletos.sort((a,b)=>a.key.localeCompare(b.key));
  }

  // Horas extras que o ADM marcou como "pagas em dinheiro" naquele mês.
  function extrasPagasDoMes(extrasPagos, mk){
    const lista = (extrasPagos || []).filter(x=>x.mes===mk);
    return {
      lista,
      mins: lista.reduce((s,x)=>s+extraMinutosConsumidos(x), 0),
      valor: lista.reduce((s,x)=>s+(Number(x.valor)||0), 0)
    };
  }

  // Resumo de horas de um mês — o mesmo número em qualquer tela.
  function resumoHorasMes(records, mk, employee, extrasPagos){
    const jornada = jornadaPadraoDoEmployee(employee);
    let totalMesMins = 0, batidosMesMins = 0, complementoMesMins = 0, extraMesMins = 0;
    keysDoMes(records, mk).forEach(k=>{
      const t = calcDia(records[k], k, employee);
      if(t && !t.falta){
        totalMesMins += t.totalMins;
        batidosMesMins += t.mins;
        complementoMesMins += t.compMins;
        extraMesMins += t.extraMins;
      }
    });
    const diasUteis = diasUteisNoMes(mk);
    const diasAbonoFolga = diasAbonoNoMes(records, mk) + diasFolgaNoMes(records, mk);
    // Abono e folga contam como cumpridos; faltas e dias sem batida geram déficit.
    const horasEsperadasMin = jornada * diasUteis;
    const horasCumpridasMin = totalMesMins + diasAbonoFolga * jornada;
    const pagas = extrasPagasDoMes(extrasPagos, mk);
    return {
      jornadaMin: jornada, diasUteis,
      totalMesMins, batidosMesMins, complementoMesMins, extraMesMins,
      horasEsperadasMin, horasFaltantesMin: Math.max(0, horasEsperadasMin - horasCumpridasMin),
      extrasPagasDoMes: pagas.lista, extrasPagasMins: pagas.mins, extrasPagasValor: pagas.valor
    };
  }

  // --- gravação segura (ver comentário no topo) ---
  function igual(a, b){ return JSON.stringify(ordenar(a)) === JSON.stringify(ordenar(b)); }
  function ordenar(v){
    if(Array.isArray(v)) return v.map(ordenar);
    if(v && typeof v === 'object'){
      const o = {}; Object.keys(v).sort().forEach(k=>{ o[k] = ordenar(v[k]); }); return o;
    }
    return v;
  }
  function clonar(v){ return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }

  // Aplica em `latest` (o que está no servidor agora) só os dias que mudaram
  // entre `base` (o que este lado tinha lido) e `mine` (o que este lado quer
  // gravar). Dia que este lado não mexeu fica exatamente como o servidor tem.
  function mesclarRecordsPorDia(base, mine, latest){
    const out = clonar(latest || {});
    const dias = new Set([...Object.keys(base || {}), ...Object.keys(mine || {})]);
    dias.forEach(k=>{
      const b = base ? base[k] : undefined, m = mine ? mine[k] : undefined;
      if(igual(b, m)) return;                      // este lado não mexeu nesse dia
      if(m === undefined) delete out[k]; else out[k] = clonar(m);
    });
    return out;
  }

  // Resposta de erro do Firestore numa gravação com precondição:
  //  - conflito: alguém gravou depois da leitura (ou apagou o documento) -> reler e mesclar;
  //  - semPrecondicao: o servidor recusou o próprio parâmetro (400 que não é
  //    conflito) -> grava como antes, sem precondição (nunca pior que antes);
  //  - qualquer outra coisa (401/403/429/5xx...) é erro de verdade.
  function classificarFalhaDeEscrita(httpStatus, statusFirestore, temPrecondicao){
    const st = String(statusFirestore || '');
    const conflito = !!temPrecondicao && (httpStatus === 409 || httpStatus === 412 || httpStatus === 404 ||
      st === 'FAILED_PRECONDITION' || st === 'ABORTED' || st === 'ALREADY_EXISTS' || st === 'NOT_FOUND');
    const semPrecondicao = !!temPrecondicao && !conflito && httpStatus === 400;
    return { conflito, semPrecondicao };
  }

  // ler()            -> { ok, records, version }   (version = marca do documento lido)
  // escrever(obj, v) -> { ok, conflito, erro }     (conflito = alguém gravou depois da leitura)
  // Se a releitura falhar, grava como antes (sem mesclar) — nunca fica pior
  // do que era.
  async function gravarRecordsComMerge(opts){
    const { base, mine, ler, escrever } = opts;
    const max = opts.tentativas || 4;
    for(let i=0; i<max; i++){
      const remoto = await ler();
      if(!remoto || !remoto.ok){
        const r = await escrever(clonar(mine), undefined);
        return r.ok ? { ok:true, merged:clonar(mine) } : { ok:false, motivo:'escrita', erro:r.erro };
      }
      const merged = mesclarRecordsPorDia(base, mine, remoto.records);
      const r = await escrever(merged, remoto.version);
      if(r.ok) return { ok:true, merged, mesclou: !igual(merged, mine) };
      if(!r.conflito) return { ok:false, motivo:'escrita', erro:r.erro };
    }
    return { ok:false, motivo:'conflito' };
  }

  return {
    JORNADA_PADRAO_MIN_DEFAULT,
    mesclarRecordsPorDia, gravarRecordsComMerge, classificarFalhaDeEscrita,
    pad, dateKeyOf, todayKey, currentMonthKey, monthKeyOf, shiftMonth,
    isFimDeSemana, isDiaUtil, diasUteisNoMes,
    timeToMinutes, formatMinutes, jornadaPadraoDoEmployee, minutosBatidos,
    folgaMinutosConsumidos, complementoMinutosConsumidos, extraMinutosConsumidos,
    calcDia, saldoHoraExtra,
    diasTrabalhadosNoMes, diasAbonoNoMes, diasFolgaNoMes, faltasNoMes, diasIncompletosDoMes,
    extrasPagasDoMes, resumoHorasMes
  };
});
