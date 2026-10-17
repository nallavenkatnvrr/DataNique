# Contributing to Datanique

Thanks for your interest in improving Datanique. This guide covers local setup,
running the test suite, and the conventions the project follows.

## Project structure

```
data-validator/
  backend/    # Python FastAPI service (compare engines, SQL IDE, connectors)
  frontend/   # React + TypeScript + Vite UI
```

See the top-level [`README.md`](./README.md) for the full architecture overview.

## Local development

### Backend

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements-dev.txt      # runtime + test deps
uvicorn app.main:app --reload --port 8000
```

### Frontend

```powershell
cd frontend
npm install
npm run dev
```

Open http://localhost:5173.

## Running the tests

The backend ships a pure-logic unit test suite that needs **no live database**:

```powershell
cd backend
.\.venv\Scripts\python.exe -m pytest
```

The tests cover:

- **`normalize`** — normalization option precedence and flag resolution
- **`schema_diff`** — auto/by-name and manual column-mapping diffs
- **`ddl_generator`** — CREATE TABLE / INSERT / EXEC generation per dialect
- **`sql_dialects`** — identifier quoting, FQ names, hashing, checksum bucketing
- **`config`** — settings parsing

### Adding tests

- Put new tests under `backend/tests/` named `test_*.py`.
- Prefer pure-logic tests that don't require a database. When a DB object is
  needed, use the `FakeConnector` helper in `tests/conftest.py`.
- Run `pytest` before opening a PR — CI runs it automatically.

## Conventions

- **Backend**: type hints everywhere; `from __future__ import annotations` at the
  top of modules. Keep engine changes behind config flags (see `app/config.py`)
  so new behavior is opt-in and falls back safely.
- **Cross-engine correctness**: any change to row hashing / normalization must
  keep the MD5 recipe identical across every dialect and engine — otherwise
  cross-DB comparisons produce phantom diffs. Add a dialect test if you touch
  `sql_dialects/`.
- **Secrets**: never commit `.env`, `.secret_key`, or database credentials.
  They are git-ignored.
- **Frontend**: TypeScript strict; components in `src/components`, routed pages
  in `src/pages`, backend calls in `src/api/client.ts`.

## Pull requests

1. Create a feature branch.
2. Keep changes focused and add/adjust tests.
3. Ensure `pytest` passes and the app boots (`uvicorn app.main:app`).
4. Describe the change and any new config flags in the PR description.
