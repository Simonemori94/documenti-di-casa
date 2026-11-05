# 🏠 Documenti di casa

Archivio personale di documenti con ricerca, scadenze e assistente (Claude).
Gira su Cloudflare (Worker + D1 + R2). Ogni modifica salvata su GitHub viene pubblicata in automatico.

## Struttura
- `worker.js` — API e assistente
- `public/index.html` — l'app (scadenze, documenti, assistente, scansione)
- `schema.sql` — tabelle del database
- `wrangler.toml` — configurazione Cloudflare

## Prima installazione (tutto da telefono)

### 1. Repository GitHub
1. GitHub → **+** → **New repository** → nome `documenti-di-casa` → **Private** → Create.
2. **Add file → Create new file** per ciascun file: `wrangler.toml`, `schema.sql`, `worker.js`, `README.md`.
3. Per l'app scrivi nel nome file `public/index.html` (lo `/` crea la cartella). Incolla il contenuto e fai **Commit**.

### 2. Database D1 (Cloudflare)
1. dash.cloudflare.com → **Storage & databases → D1 SQL database → Create** → nome `documenti-db`.
2. Apri il database → **Console** → incolla il contenuto di `schema.sql` → Execute.
3. Copia il **Database ID** (in Settings/Overview).
4. Su GitHub apri `wrangler.toml` → matita ✏️ → sostituisci `INCOLLA_QUI_L_ID` con l'ID → Commit.

### 3. Archivio file R2
1. **Storage & databases → R2 object storage → Create bucket** → nome `documenti-files`.
   (Se chiede un metodo di pagamento: il piano gratuito basta per uso personale.)

### 4. Collega GitHub a Cloudflare
1. **Workers & Pages → Create → Import a repository** → autorizza GitHub → scegli `documenti-di-casa`.
2. Lascia i valori predefiniti (deploy command: `npx wrangler deploy`) → **Save and Deploy**.
3. A fine build ottieni l'indirizzo `https://documenti-di-casa.<tuo-nome>.workers.dev`.

### 5. Chiave e password (segrete, NON su GitHub)
Worker `documenti-di-casa` → **Settings → Variables and Secrets → Add**, tipo **Secret**:
- `ANTHROPIC_API_KEY` — la chiave da console.anthropic.com
- `APP_PASSWORD` — la password per entrare nell'app (lunga!)

Poi **Deploy** (o fai un piccolo commit) per applicarle.

### 6. Usa l'app
Apri l'indirizzo, inserisci la password, poi dal menu del browser **Aggiungi a schermata Home**.

## Come modificare in futuro (da telefono)
1. GitHub → file da cambiare → ✏️ → modifica → **Commit changes**.
2. Cloudflare pubblica da solo in circa un minuto (controlla in Workers & Pages → Deployments).
3. Ricarica l'app (se vedi la versione vecchia, chiudi e riapri).

Cosa si modifica dove:
- Aspetto e schermate → `public/index.html`
- Categorie, modello Claude, comportamento dell'assistente → `worker.js`
  (`CATEGORIES`, `MODEL`, il testo di `system` in `ask`)
- Cambiare password o chiave → Cloudflare → Variables and Secrets

## Problemi comuni
- **"Non autorizzato"**: password sbagliata, o il secret non è stato applicato con un nuovo deploy.
- **Documenti senza scadenze / "Analisi non riuscita"**: controlla `ANTHROPIC_API_KEY` e il credito sul tuo account Anthropic.
- **Build fallita**: Deployments → apri l'ultima build → leggi l'errore (di solito un ID database non incollato).
