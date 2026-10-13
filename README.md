# Rotina — Controle de limpeza

Aplicação web para organizar locais, responsáveis e frequências de limpeza, registrar atividades com status e fotos e consultar um histórico centralizado.

## Funcionalidades

- Painel inicial com indicadores e atividade recente.
- Cadastro, edição, busca, filtros e exclusão de locais.
- Histórico com status **Limpo** ou **Não limpo**, data, observações e fotos de antes/depois.
- Visualização detalhada de locais e registros.
- Banco SQLite local criado automaticamente.
- Interface responsiva, acessível por teclado e com suporte à preferência por movimento reduzido.

## Requisitos

- Python 3.10+
- Node.js 18+

## Executar no Windows

Abra dois terminais na pasta do projeto.

No primeiro terminal, crie o ambiente virtual e instale as dependências. Se o comando `python` não estiver disponível no PowerShell, substitua-o pelo caminho completo do executável Python instalado:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r backend\requirements.txt
python -m uvicorn main:app --app-dir backend --reload
```

Por exemplo, no ambiente em que este projeto foi preparado:

```powershell
& "C:\Users\GABRIEL ALBUQUERQUE\AppData\Local\Microsoft\WindowsApps\python3.13.exe" -m venv .venv
& ".\.venv\Scripts\python.exe" -m pip install -r backend\requirements.txt
& ".\.venv\Scripts\python.exe" -m uvicorn main:app --app-dir backend --reload
```

No segundo terminal, instale as dependências e inicie a interface:

```powershell
cd frontend
npm install
npm run dev
```

Abra o endereço informado pelo Vite (normalmente `http://localhost:5173`). A interface encaminha as chamadas `/api` e `/uploads` para a API local em `http://127.0.0.1:8000`.

Os dados são armazenados em `backend\cleaning.db`; imagens carregadas ficam em `backend\uploads`. Para inspecionar a API, acesse `http://127.0.0.1:8000/docs`.

## Variáveis opcionais

- `CLEANING_DB_PATH`: caminho alternativo para o arquivo SQLite.
- `CLEANING_UPLOAD_DIR`: diretório alternativo para imagens carregadas.
