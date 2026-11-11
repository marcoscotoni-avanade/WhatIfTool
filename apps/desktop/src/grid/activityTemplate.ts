import type { Activity, ProjectSnapshot } from '@planner/domain';
import { editableActivityFields } from '../store/editing';

export async function activityTemplate(model: ProjectSnapshot, example?: Activity): Promise<ArrayBuffer> {
  const { default: ExcelJS } = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  const instructions = workbook.addWorksheet('Istruzioni');
  instructions.columns = [{ width: 25 }, { width: 85 }, { width: 65 }];
  instructions.addRow(['Template per Paste TSV']);
  instructions.addRow(['Procedura', 'Nel foglio Template mantenere code e solo le colonne da modificare. Copiare intestazioni e righe compilate in Paste TSV.']);
  instructions.addRow(['Inserimento e aggiornamento', 'code esistente: aggiorna. code nuovo: crea una attivita; name obbligatorio. Codici duplicati nel testo incollato non ammessi. Colonne omesse: valori predefiniti per nuove attivita. Un solo Undo annulla tutto.']);
  instructions.addRow(['Esempio', example ? 'La riga di esempio riprende una attivita del progetto. Cambiare code per creare una nuova attivita.' : 'La riga EXAMPLE crea una nuova attivita se il codice non esiste. Sostituire codice e nome prima di incollare.']);
  instructions.addRow(['Celle vuote', 'Non significano "nessuna modifica": cancellano/reimpostano i valori, oppure generano errore per campi obbligatori. Eliminare le colonne non utilizzate.']);
  instructions.addRow(['Formati', 'Celle in formato testo. Usare il punto per i decimali, date ISO UTC e true/false minuscoli. Non modificare le intestazioni.']);
  instructions.addRow(['Validazione', 'Tutte le righe sono validate prima di applicare le modifiche. I campi calcolati e i tag non sono importabili.']);
  instructions.addRow([]);
  instructions.addRow(['Colonna', 'Valori ammessi / formato', 'Note']);
  const dateFormat = 'Data ISO-8601 UTC, es. 2026-11-11T09:00:00.000Z; oppure vuoto';
  const guidance: Record<string, [string, string]> = {
    code: ['Codice attivita esistente oppure nuovo, non vuoto', 'Obbligatorio; esistente = aggiorna, nuovo = inserisce. Non rinomina un codice esistente.'],
    name: ['Testo non vuoto', 'Obbligatorio per nuove attivita; omettere la colonna per mantenere il nome delle esistenti.'],
    description: ['Testo libero, anche multilinea; oppure vuoto', 'Descrizione.'],
    type: ['TASK | MILESTONE | SUMMARY', 'MILESTONE richiede durata zero; SUMMARY non aggrega automaticamente altre attivita.'],
    effortHours: ['Numero >= 0 (ore)', 'Vuoto equivale a 0. Puo proporre il ricalcolo della durata.'],
    duration: ['Numero >= 0', 'Espresso in durationUnit. Vuoto equivale a 0.'],
    durationUnit: ['d | h', 'Giorni oppure ore; non lasciare vuoto.'],
    elapsedMode: ['true | false', 'true: durata continua 24 ore; false: calendario lavorativo. Non lasciare vuoto.'],
    scheduleMode: ['AUTO | MANUAL', 'MANUAL richiede date pianificate o un inizio effettivo; puo inizializzare un inizio pianificato.'],
    plannedStart: [dateFormat, 'Inizio pianificato; deve precedere o coincidere con la fine.'],
    plannedFinish: [dateFormat, 'Fine pianificata.'],
    actualStart: [dateFormat, 'Inizio effettivo; deve precedere o coincidere con la fine effettiva.'],
    actualFinish: [dateFormat, 'Fine effettiva.'],
    constraintType: ['ASAP | START_NO_EARLIER_THAN | FINISH_NO_LATER_THAN | MUST_START_ON | MUST_FINISH_ON | vuoto', 'Un vincolo diverso da ASAP richiede constraintDate; il sistema puo inizializzarla.'],
    constraintDate: [dateFormat, 'Data del vincolo.'],
    targetDate: [dateFormat, 'Data obiettivo della milestone.'],
    intrinsicRisk: ['Numero da 0 a 100; oppure vuoto', 'Vuoto: usa il rischio derivato da probabilita e P80.'],
    probabilityOfDelay: ['Numero da 0 a 1; oppure vuoto', 'Esempio: 0.5 = 50%.'],
    delayP80: ['Numero >= 0; oppure vuoto', 'Ritardo P80 in giorni lavorativi.'],
    calendarId: ['ID calendario esistente; oppure vuoto', 'Vuoto: calendario predefinito. Elenco ID/nome sotto.'],
    ownerId: ['ID membro del team esistente; oppure vuoto', 'Non usare il nome. Vuoto: nessun owner. Elenco ID/nome sotto.'],
    status: ['NOT_STARTED | IN_PROGRESS | COMPLETE', 'Stato attivita.'],
  };
  const fields = [...editableActivityFields];
  for (const field of fields) {
    const info = guidance[field];
    if (!info) throw new Error(`Missing template instructions for ${field}.`);
    instructions.addRow([field, ...info]);
  }
  instructions.addRow([]);
  instructions.addRow(['Calendari: ID', 'Nome']);
  model.calendars.forEach(calendar => instructions.addRow([calendar.id, calendar.name]));
  instructions.addRow([]);
  instructions.addRow(['Owner: ID', 'Nome']);
  const members = model.project.team?.members ?? [];
  members.forEach(member => instructions.addRow([member.id, member.name]));
  if (!members.length) instructions.addRow(['', 'Nessun membro definito: lasciare ownerId vuoto.']);
  const template = workbook.addWorksheet('Template', { views: [{ state: 'frozen', ySplit: 1 }] });
  template.columns = fields.map(field => ({ header: field, key: field, width: 25, style: { numFmt: '@' } }));
  const sample = example ?? {
    code: 'EXAMPLE', name: 'Example task', type: 'TASK', effortHours: 8, duration: 1,
    durationUnit: 'd', elapsedMode: false, scheduleMode: 'AUTO', status: 'NOT_STARTED',
  };
  template.addRow(fields.map(field => String(Reflect.get(sample, field) ?? '')));
  for (const sheet of [instructions, template]) {
    sheet.eachRow(row => {
      row.alignment = { vertical: 'top', wrapText: true };
      if (sheet === instructions) row.height = 45;
    });
    sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF217F93' } };
  }
  instructions.getRow(9).font = { bold: true };
  const buffer = await workbook.xlsx.writeBuffer();
  return new Uint8Array(buffer).buffer;
}
