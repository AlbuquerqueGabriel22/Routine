# Routiner

Aplicativo web instalável para organizar locais, equipes e registros de limpeza. A API em Python/FastAPI e a interface React usam SQLite local por padrão.

## Recursos

- Cadastro de empresas com nome fantasia, identificador, e-mail e senha.
- Cadastro de funcionários pela empresa, com setor, identificador e senha.
- Login da empresa no formato `empresa.routine` e do funcionário no formato `usuario.empresa.routine`.
- Visão separada por empresa: o chefe vê os dados e a equipe da própria empresa; cada funcionário consulta os próprios registros.
- Cadastro e manutenção de locais pela empresa; funcionários podem consultá-los e registrar atividades.
- Histórico de atividades com data, status, observações e fotos antes/depois. Os registros não possuem operação de edição.
- Fotos protegidas por sessão e escopo da empresa/conta.
- Layout responsivo e instalação como aplicativo pelo navegador compatível.

## Requisitos

- Python 3.10+
- Node.js 18+

## Executar no Windows

Abra dois terminais na pasta do projeto.

No primeiro terminal, crie o ambiente virtual e instale as dependências:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r backend\requirements.txt
.\.venv\Scripts\python.exe -m uvicorn main:app --app-dir backend --reload
```

Se `python` não estiver disponível, use o caminho completo do executável Python instalado para criar o ambiente. Depois, os comandos do projeto podem usar `.\.venv\Scripts\python.exe`.

Neste computador, o Python instalado pode ser chamado assim:

```powershell
& "C:\Users\GABRIEL ALBUQUERQUE\AppData\Local\Microsoft\WindowsApps\python3.13.exe" -m venv .venv
```

No segundo terminal:

```powershell
cd frontend
npm install
npm run dev
```

Abra o endereço informado pelo Vite (normalmente `http://localhost:5173`). O frontend encaminha `/api` e `/uploads` para a API local em `http://127.0.0.1:8000`. A documentação interativa da API fica em `http://127.0.0.1:8000/docs`.

Cadastre uma empresa na tela inicial. Para criar funcionários, entre como empresa e abra **Equipe**. A aplicação apresenta o login completo do funcionário após o cadastro.

## Instalar como aplicativo

O modo de desenvolvimento do Vite não registra o service worker. Mantenha a API do primeiro terminal em execução e, no segundo, gere e sirva a versão de produção:

```powershell
cd frontend
npm run build
npm run preview
```

Abra o endereço local exibido pelo preview e use **Instalar app** quando oferecido pelo navegador, ou a opção de instalação do menu do navegador. HTTPS é necessário para instalação fora de `localhost`.

## Armazenamento e configuração

- Banco de dados: `backend\cleaning.db`.
- Imagens: `backend\uploads`.
- Segredo de sessão: `backend\.auth_secret`, criado automaticamente e ignorado pelo Git.
- Registros preexistentes sem empresa associada continuam no banco, mas não são mostrados a nenhuma conta. Associe-os manualmente à empresa correta antes de migrá-los.
- `CLEANING_DB_PATH`: caminho alternativo para o SQLite.
- `CLEANING_UPLOAD_DIR`: diretório alternativo para imagens.
- `ROUTINER_AUTH_SECRET`: segredo opcional para assinar sessões; use pelo menos 32 caracteres e guarde-o fora do repositório.
- `ROUTINER_ALLOWED_ORIGINS`: origens CORS autorizadas, separadas por vírgulas.

Faça backup do banco e das imagens juntos. Este projeto está preparado para execução local; antes de publicar na internet, configure HTTPS, segredos exclusivos, backups e uma estratégia de hospedagem/armazenamento adequada.
