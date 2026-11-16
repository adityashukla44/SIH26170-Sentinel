# SIH26170 — AI Component Screening

AI-driven anomaly detection and burn-in screening for spacecraft electronic components, with **Sentinel**, a screening console that runs on top of the API.

## Run

```
source .venv/bin/activate
uvicorn app.main:app --reload
```

Then open **http://localhost:8000**. The backend serves the dashboard itself, so there is nothing else to install or start. The API docs are at http://localhost:8000/docs.

Click **Screen the sample batch** for a one-click demo on `data/burn_in_dataset.csv` (200 labelled components), or open **Burn-in CSV** in the header and drop your own file.

## Dashboard

| View | What it shows |
|---|---|
| **Home** (`#/`) | The burn-in screening landing page: the "PROOF for every component" hero with the glossy ring, faint burn-in traces behind it and the columns a CSV needs. Below it, an animated burn-in monitor plays one illustrated run from 0 h to 168 h (healthy band, an edge part, a latent defect, an obvious failure), with the drift model's dashed 168 h forecasts and the verdict each part gets. Then the three steps, the three verdicts, live forecast-model facts from `/health` and a closing call to action. |
| **Burn-in CSV** (`#/upload`) | Its own page for uploading. Drag-and-drop CSV intake; columns, numbers and duplicate IDs are checked in the browser before upload, and the pipeline animates while the batch is screened. When a batch is already loaded, a card shows it with a link back to its overview. |
| **Overview** | Batch yield, PASS / REVIEW / FAIL counts, the risk map (anomaly score against drift, deviation or forecast growth), highest-risk components, batch current over burn-in, batch statistics, the ground-truth check against the optional `Label` column and the forecast check. |
| **Components** | Every component in a sortable, searchable, filterable table with burn-in sparklines and score meters. Export the current view as CSV. |
| **Detail panel** | Opens from any component: verdict and score gauge, current against the batch band with the ML forecast, the five weighted signals with points, score floors and escalations, stage drift and every reading. Download a JSON report or copy a text summary. |
| **Simulator** | What-if scoring against the loaded batch. Move sliders or start from Healthy, Latent defect, Obvious failure or Dynamic outlier, and the verdict updates live. |
| **Method** | The pipeline, scoring weights, thresholds, forecast rules and API, for judges and reviewers. |

Header: the boxed Sentinel logo goes home; the tabs are Home, Overview, Components, Simulator and Method; the dashed **Burn-in CSV** option opens the upload page and, once a batch is screened, shows that file and its component count. On phones the tabs move to a bottom bar (Home, CSV, Overview, Components, More), and More opens Simulator and Method.

Keyboard: `1`–`5` switch to Home, Overview, Components, Simulator and Method, `N` opens Burn-in CSV for a new batch, `/` searches, `←` `→` step through components, `Esc` closes the panel or the More menu, `T` switches light and dark, `?` lists shortcuts.

Light and dark themes, phone / tablet / desktop layouts, no frontend libraries, fonts self-hosted, works offline.

If you open `frontend/index.html` from disk or host it elsewhere, add `?api=http://127.0.0.1:8000` once and it is remembered.

## APIs

```
GET  /health                        status, version, model info
POST /batch/screen                  CSV → every component screened, batch kept for the simulator
POST /batch/{batch_id}/simulate     JSON component → screened against a stored batch
POST /batch/analyze-component       CSV + component_id → one component vs its batch
POST /batch/analyze                 CSV → batch statistics
POST /analyze                       JSON component → quick single check
GET  /sample/burn_in_dataset.csv    the bundled sample dataset
```

`/batch/analyze-component` keeps its original fields and now also returns the raw readings, `label` and a `score_breakdown`. All additions are optional fields, so existing clients keep working.

## Main workflow

CSV → Validation → Batch Statistics → Anomaly Signals → Drift Analysis → 168h Forecast → Risk Scoring → Explanation → PASS / REVIEW / FAIL

## 168 h forecast model

`models/drift_model.pkl` is the **Drift growth model** (`app/drift_model.py`). It predicts how much a component's current will grow between 24 h and 168 h from how much it drifted in the first 24 h:

```
168 h = 24 h × (1.044 + 1.302 × early drift)      early drift = (24 h − 0 h) ÷ 0 h
```

It is a robust (Huber) regression, trained on `data/burn_in_dataset.csv`. Because it works in ratios rather than absolute microamps, it carries over to batches that run at a different current level, and a part that doesn't drift is forecast not to grow.

Cross-validated on the 200 components (5 folds, so every component is forecast by a model that never saw it, then screened with the real rules):

| Model | MAE | Median error | Defects caught | Healthy flagged |
|---|---|---|---|---|
| **Drift growth model (Huber)** | 4.77 µA | 1.28 µA | 40 / 40 | **0 / 120** |
| Growth model, monotonic HistGB | 3.91 µA | 0.64 µA | 40 / 40 | 4 / 120 |
| GradientBoosting on raw currents | 3.93 µA | 0.75 µA | 40 / 40 | 1 / 120 |
| RandomForest on raw currents | 4.60 µA | 1.36 µA | 40 / 40 | 11 / 120 |
| Previous `drift_model.pkl` (RandomForest, ~10 µA data) | 14.3 µA | — | 40 / 40 | 118 / 120 |

The mean error is driven by latent defects, which look healthy at 24 h by definition (CV MAE: healthy 0.91 µA, latent defects 18.5 µA). The measured 168 h current still catches them; the forecast's job is not to raise false alarms on healthy parts. The raw-current models score a lower MAE, but they forecast a flat 15 µA part to reach 35 µA, so they don't transfer.

Retrain after changing the data (writes `models/drift_model.pkl` and `models/drift_model.json`):

```
python -m app.train_drift_model --compare
```

The JSON holds the formula, the cross-validated metrics, the trusted input range, the scikit-learn version and a fingerprint of each training row. It is checked against the `.pkl` it was written with, so a model dropped in without fresh metadata is never described by stale numbers. The previous model is still in git: `git show 47946cd:models/drift_model.pkl > old_drift_model.pkl`.

**Out-of-range guard.** A forecast is only used when the input is inside the range the model was trained on (for this model, early drift between −64% and +146%; for tree models, their split range plus 10%). Anything else uses the linear fallback and reports `FALLBACK_OUT_OF_RANGE`. On its own, this guard would have cut the old model's false alarms from 118 to 2.

## Forecast check

`/batch/screen` compares the forecast with the measured 168 h current in the CSV: mean and median error, share within ±10%, distinct forecast values, the share from the ML model, components outside the trusted range, the cross-validated error from training and how much of the batch the model was trained on. It warns when most components get the same forecast, when 25% or more fall outside the trusted range, or when the median error exceeds 15% of a typical 168 h reading. On the sample batch, which is the training data, the errors are in-sample; the dashboard says so and points to the cross-validated figure.

## Units

All currents are in µA. Temperature in °C, voltage in V.

## Tests

```
pytest
```

## Folder structure

```
app/main.py               FastAPI endpoints, batch store, serves the dashboard
app/batch_analysis.py     Validation, per-component scoring, batch screening, checks
app/prediction_engine.py  168h forecast (model loaded once), range guard, fallback, model info
app/drift_model.py        Drift growth model class (pickled into models/drift_model.pkl)
app/train_drift_model.py  Training script: cross-validation, comparison, model + metadata
app/analysis_engine.py    Rules for the quick /analyze endpoint
app/schemas.py            Request and response models
frontend/index.html       Dashboard markup and icon sprite
frontend/css/             Design tokens, layout, components, light and dark themes
frontend/js/app.js        Views, routing, simulator, export, shortcuts
frontend/js/home.js       Home page art: hero burn-in traces and the animated burn-in monitor
frontend/js/charts.js     Hand-drawn SVG charts (risk map, trajectories, gauge)
frontend/js/csv.js        In-browser CSV checks that mirror the backend
frontend/fonts/           Manrope (SIL Open Font License)
data/                     Burn-in datasets
models/drift_model.pkl    168h drift model
models/drift_model.json   Training facts and metrics for that model
tests/                    API tests
```
