# Istruzioni per Researcher: generare un progetto importabile

Queste istruzioni servono a un assistente AI che conosce un piano di progetto e deve convertirlo
in un file importabile da **Project Risk Planner**. Puoi copiarle nel prompt di Researcher o
allegare questo documento alla richiesta, insieme alle fonti autorizzate.

> **Riservatezza:** Researcher potrebbe essere un servizio esterno. Prima di condividere documenti
> o dati di progetto, verifica di essere autorizzato a inviarli a quel servizio e, se necessario,
> rimuovi o anonimizza le informazioni riservate.

## Prompt da fornire all'AI

Sei un analista di pianificazione. Analizza il piano e le fonti che ti sono state fornite e
prepara un progetto per Project Risk Planner. Lo scopo è ottenere un grafo di attività,
dipendenze e milestone utilizzabile per analisi di schedulazione e rischio.

### Obiettivo e output

1. Produci un **unico file JSON UTF-8**, per esempio `progetto.json`, conforme allo schema e
   alle regole seguenti. Deve rappresentare un **nuovo progetto**, non una modifica a uno esistente.
2. Se puoi creare allegati, consegna il file `.json` scaricabile. Altrimenti scrivi il JSON completo
   in un unico blocco di codice `json`, senza prefissi, commenti, omissioni o segnaposto al suo
   interno: l'utente potrà copiarlo e salvarlo come file `.json`.
3. Fuori dal JSON, fornisci un breve rapporto con fonti, corrispondenze tra attività, assunzioni
   approvate, valori provvisori e informazioni mancanti. Non inserire il rapporto nel JSON.
4. Non produrre un file `.pgplan`: quel formato è un database SQLite generato dal tool, non un
   file JSON rinominato.

### Analisi delle fonti e incertezze

- Usa le informazioni disponibili: attività, codici, date, durate, effort, milestone, predecessori,
  tipi di dipendenza, lag, stato e dati di rischio, quando documentati.
- Se ricevi più fonti, confrontale. Unifica due voci solo quando è ragionevolmente dimostrabile che
  rappresentano la stessa attività; non dedurre l'identità dal solo nome generico.
- In caso di conflitti fra fonti, date ambigue, dipendenze incerte o informazioni obbligatorie
  mancanti, elenca le alternative con la relativa fonte e chiedi all'utente di scegliere. **Non
  presentare una scelta incerta come fatto.** Non generare un file definitivo per un piano che
  contiene ancora dati obbligatori o conflitti decisivi irrisolti.
- Non inventare dipendenze, date, durate, effort o dati quantitativi di rischio. Riporta le
  dipendenze solo quando supportate dalle fonti o confermate dall'utente. Se le fonti non specificano
  un tipo o lag, chiedi conferma prima di usare una convenzione.
- Per campi facoltativi sconosciuti **ometti la proprietà**, non usare `null`, stringhe vuote o
  stime inventate. In particolare, non assegnare `intrinsicRisk`, `probabilityOfDelay` o `delayP80`
  se non sono documentati o approvati. Se mancano dati di rischio il tool può mostrare esposizione
  zero: segnala che **zero calcolato non significa rischio assente**.
- Per i campi obbligatori `projectStart`, `duration` ed `effortHours`, se il dato non è disponibile
  chiedilo all'utente. Se l'utente autorizza un valore provvisorio, registralo esplicitamente nel
  rapporto: per esempio `effortHours: 0` può essere un segnaposto approvato, non una stima reale.
  Non usare durata zero per una normale attività solo perché sconosciuta.
- Mantieni separate durata ed effort: `duration` misura il tempo di calendario lavorativo o
  trascorso; `effortHours` misura le ore di lavoro. **Non derivare automaticamente l'uno
  dall'altro.**
- Conserva descrizioni e nomi nella lingua delle fonti. I codici tecnici, i nomi dei campi e gli
  enum del JSON devono invece rispettare esattamente quelli indicati sotto.

### Struttura obbligatoria

Il file deve contenere **un oggetto JSON**, non una lista e non un oggetto racchiuso in `data`:

```text
{
  "schemaVersion": 1,
  "project": { ... },
  "activities": [ ... ],
  "dependencies": [ ... ],
  "calendars": [ ... ],
  "scenarios": [],
  "overrides": [],
  "baselines": [],
  "settings": { ... }
}
```

Le parentesi e i puntini di questo schema sono illustrativi e **non sono JSON valido**.
Il progetto completo nella sezione «Esempio completo» mostra un file valido.
Per questa importazione iniziale lascia `scenarios`, `overrides` e `baselines` come array vuoti:
baseline e scenari si potranno creare nel tool dopo la revisione.

#### Progetto: `project`

| Campo | Tipo | Regola |
|---|---|---|
| `id` | stringa | Identificatore non vuoto, unico nel documento, per esempio `project-erp`. |
| `name` | stringa | Nome del progetto non vuoto. |
| `description` | stringa | Facoltativa. |
| `projectStart` | data ISO UTC | Data e ora di inizio del progetto. Obbligatoria. |
| `targetFinish` | data ISO UTC | Facoltativa: scadenza complessiva, se documentata. |
| `defaultCalendarId` | stringa | Deve corrispondere all'`id` di un calendario in `calendars`. |
| `team` | oggetto | Facoltativo: `{"name":"Team","calendarId":"standard","members":[{"id":"marco","name":"Marco","allocationPercent":50}]}`. Il calendario deve esistere; ID persone unici, allocazione da 0 a 100. Non inventare persone o allocazioni. |
| `createdAt`, `modifiedAt` | data ISO UTC | Metadati obbligatori; usa la data e ora effettiva di generazione, senza inventare date storiche. |

#### Attività: ogni elemento di `activities`

| Campo | Tipo | Regola |
|---|---|---|
| `id` | stringa | Identificatore stabile, non vuoto e unico tra le attività. Non deve essere necessariamente un UUID. |
| `projectId` | stringa | Esattamente uguale a `project.id`. |
| `code`, `name` | stringa | Non vuoti. Usa codici distinti e leggibili. |
| `description` | stringa | Facoltativa. |
| `type` | stringa | `TASK`, `MILESTONE` oppure `SUMMARY`. Una `SUMMARY` è un'attività autonoma: il tool **non** calcola aggregazioni gerarchiche automatiche. |
| `effortHours` | numero | Ore di lavoro, maggiore o uguale a zero. Non confonderle con la durata. |
| `duration` | numero | Numero non negativo. Per `MILESTONE` deve essere esattamente `0`. |
| `durationUnit` | stringa | `d` per giorni oppure `h` per ore. |
| `elapsedMode` | booleano | `false` per durata lavorativa secondo calendario; `true` per tempo trascorso continuo. Un giorno trascorso equivale a 24 ore. Se non specificato chiedi conferma prima di assumere `false`. |
| `scheduleMode` | stringa | `AUTO` oppure `MANUAL`. Se non specificato chiedi conferma prima di assumere `AUTO`. |
| `plannedStart`, `plannedFinish` | data ISO UTC | Facoltative; date pianificate indicate dall'utente, non risultati calcolati. Se entrambe sono presenti, la fine non precede l'inizio. |
| `actualStart`, `actualFinish` | data ISO UTC | Facoltative; solo date effettive documentate. La fine non precede l'inizio. |
| `constraintType` | stringa | Facoltativo: `ASAP`, `START_NO_EARLIER_THAN`, `FINISH_NO_LATER_THAN`, `MUST_START_ON`, `MUST_FINISH_ON`. |
| `constraintDate` | data ISO UTC | Obbligatoria se il vincolo è diverso da `ASAP`. |
| `targetDate` | data ISO UTC | Facoltativa; scadenza di una milestone, se documentata. |
| `intrinsicRisk` | numero | Facoltativo: esposizione intrinseca manuale da 0 a 100, **non** probabilità. Prevale sul calcolo intrinseco. |
| `probabilityOfDelay` | numero | Facoltativo: probabilità di ritardo da 0 a 1; ad esempio 60% = `0.6`, non `60`. |
| `delayP80` | numero | Facoltativo: ritardo credibile/P80 in giorni lavorativi nominali, non negativo. |
| `calendarId` | stringa | Facoltativo: se presente, deve riferirsi a un calendario esistente. Se assente, usa quello predefinito del progetto. |
| `ownerId` | stringa | Facoltativo: deve coincidere con l'`id` di una persona in `project.team.members`. Non inventare assegnazioni. |
| `status` | stringa | Facoltativo: `NOT_STARTED`, `IN_PROGRESS` oppure `COMPLETE`. |
| `graphPosition` | oggetto | Obbligatorio: `{"x": 0, "y": 0}`, con numeri finiti. Per renderlo leggibile usa posizioni distinte, per esempio `x` crescente di 340 lungo le dipendenze e `y` crescente di 220 per rami paralleli. Le posizioni sono solo layout e non implicano dipendenze. |

Per una `MANUAL` è richiesto almeno uno fra `plannedStart`, `plannedFinish` o `actualStart`.
Non inserire `calculatedStart`, `calculatedFinish`, slack, percorso critico o punteggi calcolati:
sono risultati del motore, non dati da generare. `plannedFinish` di un'attività `AUTO` è
informativa e non forza la schedulazione; se la fonte indica un vincolo, rappresentalo come
vincolo solo dopo averne chiarito il significato.

#### Dipendenze: ogni elemento di `dependencies`

| Campo | Tipo | Regola |
|---|---|---|
| `id` | stringa | Non vuoto e unico fra le dipendenze, per esempio `dep-001`. |
| `projectId` | stringa | Esattamente uguale a `project.id`. |
| `predecessorId` | stringa | `id` dell'attività precedente, già presente in `activities`. |
| `successorId` | stringa | `id` dell'attività successiva, già presente in `activities`. |
| `type` | stringa | `FS` fine-inizio, `SS` inizio-inizio, `FF` fine-fine oppure `SF` inizio-fine. |
| `lag` | numero | Ritardo positivo, zero o anticipo negativo. |
| `lagUnit` | stringa | `d` oppure `h`. Il lag usa il calendario del successore. |
| `edgeWeight` | numero | Facoltativo, fra 0 e 1; se assente il motore usa 1. Non inventare pesi. |

Il grafo deve essere **aciclico**: nessun percorso deve tornare all'attività di partenza.
Sono vietati collegamenti di un'attività a sé stessa e più collegamenti con la stessa coppia
direzionale predecessore/successore, anche se hanno tipo diverso. Se le fonti ne richiedono più
di uno, segnala la limitazione invece di eliminarne uno silenziosamente.
Non collegare automaticamente le attività solo perché compaiono in sequenza nel documento.

#### Calendario: `calendars`

Se l'utente conferma un calendario standard lunedì-venerdì 09:00-17:00 UTC, usa:

```json
{
  "id": "standard",
  "name": "Standard 8h / Monday-Friday (UTC)",
  "workingDays": [1, 2, 3, 4, 5],
  "workingIntervals": [{ "start": "09:00", "end": "17:00" }],
  "holidays": [],
  "exceptions": []
}
```

Inseriscilo **dentro l'array** `calendars` e imposta `project.defaultCalendarId` a `standard`.
I giorni sono numerati da 0 = domenica a 6 = sabato. Gli intervalli `HH:mm` devono essere
ordinati, non sovrapposti, e avere inizio precedente alla fine. Le festività sono stringhe
`YYYY-MM-DD`; un'eccezione sostituisce gli intervalli del giorno, per esempio
`{"date":"2026-12-24","intervals":[{"start":"09:00","end":"13:00"}]}`.
`"intervals":[]` indica una giornata non lavorativa. Non inventare festività o calendari:
chiedi conferma, oppure dichiara che il calendario standard è un'ipotesi approvata.

#### Impostazioni: `settings`

Usa le impostazioni predefinite, salvo istruzioni esplicite diverse dell'utente:

```json
{
  "riskThreshold": 0.5,
  "defaultDamping": 0.8,
  "transmissionCap": 0.95,
  "defaultImpactHorizon": 5,
  "riskColorThresholds": [25, 50, 75]
}
```

La soglia, il damping e il cap sono tra 0 e 1; l'orizzonte è positivo e le tre soglie colore
sono crescenti fra 0 e 100. Il Risk Exposure Score è un indicatore deterministico, **non una
probabilità statisticamente calibrata**.

### Date e unità: attenzione

- Usa date e orari espliciti in ISO 8601 UTC, ad esempio `2026-03-02T09:00:00.000Z`.
- Le fonti potrebbero indicare date locali senza fuso orario: chiedi conferma prima di convertirle
  in UTC. Non aggiungere `Z` a un'ora locale come se fosse già UTC.
- Se una fonte indica solo un giorno, chiarisci se rappresenta l'inizio, la fine o la scadenza
  e quale ora usare. Nel calendario standard un inizio può essere alle 09:00 UTC e una fine
  alle 17:00 UTC, **solo se questa convenzione è stata approvata**. Una stringa con sola data
  viene interpretata dal tool alle 09:00 UTC.
- Una giornata lavorativa standard è di 8 ore, non 24; `elapsedMode: true` usa invece il tempo
  continuo. Non trasformare settimane o mesi in giorni senza una regola approvata.

### Controlli finali prima della consegna

1. Verifica che il contenuto sia JSON valido: doppi apici, numeri come numeri, booleani come
   booleani, nessun commento, `undefined`, `NaN`, virgola finale o testo fuori dall'oggetto.
2. Verifica la presenza di tutte le proprietà obbligatorie e dei tre array vuoti per scenari,
   override e baseline.
3. Controlla coerenza degli ID e dei `projectId`, esistenza dei calendari e degli estremi di
   ogni dipendenza, assenza di doppioni, collegamenti a sé stessi e cicli.
4. Controlla che ogni milestone abbia durata zero; che durate ed effort siano non negativi;
   che date e vincoli siano coerenti; che il rischio sia negli intervalli corretti.
5. Se hai accesso agli strumenti del repository, valida il file con l'importatore reale e con
   il motore di schedulazione. Altrimenti esegui i controlli disponibili e dichiara che non hai
   potuto verificare l'importazione nel tool: non dichiarare un test non eseguito.
6. Presenta nel rapporto separato le fonti per le decisioni più importanti, i conflitti risolti,
   ciò che resta da verificare e l'eventuale uso di valori provvisori.

## Esempio completo

L'esempio seguente è fittizio: date, durate, dipendenze e rischio non sono proposte per il
progetto reale. La voce `createdAt` è fissa solo per illustrare il formato; in un file reale
usa l'istante di generazione.

```json
{
  "schemaVersion": 1,
  "project": {
    "id": "project-demo",
    "name": "Esempio progetto",
    "description": "Esempio illustrativo per l'importazione.",
    "projectStart": "2026-03-02T09:00:00.000Z",
    "targetFinish": "2026-03-11T17:00:00.000Z",
    "defaultCalendarId": "standard",
    "createdAt": "2026-03-01T10:00:00.000Z",
    "modifiedAt": "2026-03-01T10:00:00.000Z"
  },
  "activities": [
    {
      "id": "activity-design",
      "projectId": "project-demo",
      "code": "DES-001",
      "name": "Progettazione",
      "type": "TASK",
      "effortHours": 16,
      "duration": 2,
      "durationUnit": "d",
      "elapsedMode": false,
      "scheduleMode": "AUTO",
      "status": "NOT_STARTED",
      "graphPosition": { "x": 0, "y": 0 }
    },
    {
      "id": "activity-migration",
      "projectId": "project-demo",
      "code": "MIG-001",
      "name": "Migrazione dati",
      "type": "TASK",
      "effortHours": 24,
      "duration": 3,
      "durationUnit": "d",
      "elapsedMode": false,
      "scheduleMode": "AUTO",
      "intrinsicRisk": 70,
      "probabilityOfDelay": 0.6,
      "delayP80": 4,
      "status": "NOT_STARTED",
      "graphPosition": { "x": 340, "y": 0 }
    },
    {
      "id": "activity-go-live",
      "projectId": "project-demo",
      "code": "LIVE-001",
      "name": "Go live",
      "type": "MILESTONE",
      "effortHours": 0,
      "duration": 0,
      "durationUnit": "d",
      "elapsedMode": false,
      "scheduleMode": "AUTO",
      "targetDate": "2026-03-11T17:00:00.000Z",
      "status": "NOT_STARTED",
      "graphPosition": { "x": 680, "y": 0 }
    }
  ],
  "dependencies": [
    {
      "id": "dep-001",
      "projectId": "project-demo",
      "predecessorId": "activity-design",
      "successorId": "activity-migration",
      "type": "FS",
      "lag": 0,
      "lagUnit": "d"
    },
    {
      "id": "dep-002",
      "projectId": "project-demo",
      "predecessorId": "activity-migration",
      "successorId": "activity-go-live",
      "type": "FS",
      "lag": 0,
      "lagUnit": "d"
    }
  ],
  "calendars": [
    {
      "id": "standard",
      "name": "Standard 8h / Monday-Friday (UTC)",
      "workingDays": [1, 2, 3, 4, 5],
      "workingIntervals": [{ "start": "09:00", "end": "17:00" }],
      "holidays": [],
      "exceptions": []
    }
  ],
  "scenarios": [],
  "overrides": [],
  "baselines": [],
  "settings": {
    "riskThreshold": 0.5,
    "defaultDamping": 0.8,
    "transmissionCap": 0.95,
    "defaultImpactHorizon": 5,
    "riskColorThresholds": [25, 50, 75]
  }
}
```

## Come importare il file nel tool

1. Salva il file restituito da Researcher come `progetto.json` in UTF-8. Se era in un blocco
   di codice, salva **solo il contenuto JSON**, senza i delimitatori.
2. Nell'app apri **Import / Export** e scegli **JSON - complete project**.
3. Seleziona il file e premi **Validate & import**. L'importazione sostituisce il progetto
   attualmente aperto: salva prima eventuali modifiche che vuoi conservare.
4. Controlla attività, dipendenze, date, conflitti, calendario e rischio rispetto alle fonti e
   al rapporto dell'AI. L'importazione valida la struttura, ma non può verificare se i contenuti
   rispecchino fedelmente i documenti originali.
5. Usa **Save** o **Save As** per conservare il progetto. Su desktop puoi salvarlo come `.pgplan`;
   nel browser **Save As** scarica il file `.pgplan`.

Questa procedura usa l'importazione JSON già esistente. Non implica che il tool abbia già una
funzione integrata di lettura AI di Excel, PDF o Word.
