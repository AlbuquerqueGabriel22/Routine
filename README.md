# Routiner

Aplicativo web instalável para organizar locais, equipes e registros de limpeza. A API em Python/FastAPI e a interface React usam SQLite local por padrão.

## Recursos

- Cadastro de empresas com nome fantasia, identificador, e-mail e senha.
- Cadastro de funcionários pela empresa, com setor, identificador e senha.
- Login da empresa no formato `empresa.routine` e do funcionário no formato `usuario.empresa.routine`.
- Visão separada por empresa: o chefe vê os dados e a equipe da própria empresa; cada funcionário consulta os próprios registros.
- Cadastro e manutenção de locais pela empresa; funcionários podem consultá-los e registrar atividades.
- Tarefas com prazo: a empresa atribui a um funcionário e define data e hora; o funcionário confirma ciência e pode registrar a conclusão.
- Alertas visuais de prazo ficam mais urgentes conforme a data se aproxima. A empresa recebe no sino os registros de ciência e conclusão, com funcionário, setor, tarefa e prazo.
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

Mantenha os dois terminais abertos enquanto usa o app. Se aparecer um erro de conexão, confirme que `http://127.0.0.1:8000/api/health` mostra `{"status":"ok"}` e use o endereço impresso pelo Vite; o link de `npm run preview` deixa de funcionar quando o preview é encerrado.

Cadastre uma empresa na tela inicial. Para criar funcionários, entre como empresa e abra **Equipe**. A aplicação apresenta o login completo do funcionário após o cadastro.

## Instalar como aplicativo

O modo de desenvolvimento do Vite não registra o service worker. Mantenha a API do primeiro terminal em execução e, no segundo, gere e sirva a versão de produção:

```powershell
cd frontend
npm run build
npm run preview
```

Abra o endereço local exibido pelo preview e use **Instalar app** quando oferecido pelo navegador, ou a opção de instalação do menu do navegador. HTTPS é necessário para instalação fora de `localhost`.

## Gerar instalador para Windows

O instalador desktop inclui o aplicativo e uma API Python empacotada; quem instala não precisa instalar Python ou Node.js. A API é iniciada ao abrir o Routiner, fica restrita ao próprio computador e é encerrada quando o aplicativo fecha.

Na máquina de desenvolvimento, com Node.js e Python instalados, execute na pasta do projeto:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r backend\requirements-desktop.txt
npm install
npm run desktop:win
```

Se o comando `python` não estiver disponível, substitua-o pelo caminho completo do Python já indicado acima. O instalador final será criado em `release\Routiner-Setup-1.0.6.exe`. Também é possível [baixar o instalador para Windows 64 bits na Release v1.0.6](https://github.com/AlbuquerqueGabriel22/Routine/releases/download/v1.0.6/Routiner-Setup-1.0.6.exe). A pessoa usuária só precisa instalá-lo e abrir **Routiner** pelo atalho criado.

O banco e as fotos ficam no perfil do usuário, fora da pasta de instalação: `%APPDATA%\Routiner\data\routiner.db` e `%APPDATA%\Routiner\data\uploads`. Esses dados permanecem após fechar ou atualizar o app; desinstalar o aplicativo não é necessário para iniciar a API ou criar o banco. Faça cópia de segurança dessa pasta regularmente. A base antiga da versão de desenvolvimento não é incluída no instalador; contas e dados preexistentes precisam de migração separada.

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
