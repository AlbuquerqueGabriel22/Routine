# Routiner

Aplicativo web instalável para organizar locais, equipes e registros de limpeza. A API em Python/FastAPI e a interface React usam SQLite local por padrão; com `DATABASE_URL`, a API usa PostgreSQL remoto. A interface web e a API podem ser publicadas juntas no Railway para que contas e dados fiquem disponíveis em outros dispositivos.

## Recursos

- Cadastro de empresas com nome fantasia, identificador, e-mail e senha.
- Cadastro de funcionários pela empresa, com setor, identificador e senha.
- Cadastro e organização de setores por empresa; filtros de locais, tarefas e histórico são preenchidos pelos setores cadastrados e acompanham os novos setores. Funcionários e responsáveis de locais são vinculados a um setor. A empresa pode editar o nome/setor de funcionários e alterar os dados, o prazo e o responsável das demandas pendentes.
- Login da empresa no formato `empresa.routine` e do funcionário no formato `usuario.empresa.routine`.
- Visão separada por empresa e setor: a empresa vê todos os setores; cada funcionário consulta os locais e o histórico vinculados a responsáveis do próprio setor. Os locais devem ser associados a um funcionário cadastrado do setor selecionado.
- Cada local pode ter uma rotina automática: escolha setor, área, responsável, dias da semana e horário limite. Uma tarefa é criada para cada ocorrência programada e fica disponível para o setor do responsável.
- Tarefas que não forem concluídas até o prazo passam automaticamente ao histórico como “Não feito” e não podem ser editadas. Somente a empresa pode removê-las do histórico.
- As tarefas atribuídas aparecem para todos os funcionários do setor responsável, e somente colegas do mesmo setor podem dar ciência ou executá-las. Se outra pessoa do setor executar a tarefa, deve informar o motivo; o histórico identifica separadamente o responsável original e o funcionário que executou.
- No histórico, o funcionário que executou aparece em coluna própria entre o responsável e a data; o motivo informado por quem executou no lugar de outra pessoa fica nas observações do registro.
- Tarefas com prazo: a empresa atribui a um funcionário e define data e hora; o funcionário confirma ciência e pode registrar a conclusão.
- Alertas visuais de prazo ficam mais urgentes conforme a data se aproxima. A empresa recebe no sino os registros de ciência e conclusão, com funcionário, setor, tarefa e prazo.
- O funcionário conclui a tarefa pelo botão “Fazer tarefa”, capturando obrigatoriamente as fotos de antes e depois diretamente pela câmera; as imagens não podem ser escolhidas da galeria nem editadas. As conclusões aparecem no histórico.
- Cada conta pode escolher tema claro, escuro, seguir o sistema ou personalizar a cor de destaque nas configurações do perfil.
- Histórico de atividades com data, status, observações e fotos antes/depois. Os registros não possuem operação de edição.
- O histórico permite filtrar tarefas concluídas e não realizadas e informa setor, responsável, executor e data/hora.
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

## Hospedar no Debian e acessar pela internet

O projeto pode ficar no seu Debian como servidor central. O PostgreSQL guarda contas e tarefas; um volume Docker preserva fotos e dados do banco após reinicializações. O Tailscale Funnel fornece um endereço HTTPS público sem abrir portas no roteador. Instale o Tailscale apenas no Debian; os clientes acessam pelo app sem instalar Tailscale. Como o endereço é público, compartilhe-o somente com os usuários previstos e use senhas fortes.

1. Instale Docker Engine com o plugin Docker Compose e Tailscale no Debian. Entre no Tailscale no Debian. Habilite HTTPS e Funnel na configuração do tailnet quando solicitado.
2. Copie o projeto para o Debian e entre na pasta do projeto. Crie `.env` a partir de `.env.debian.example` e substitua os dois valores de exemplo por segredos diferentes, cada um com pelo menos 32 caracteres. Para gerar segredos hexadecimais no Debian, execute `openssl rand -hex 32` duas vezes. Nunca compartilhe nem envie o `.env` ao Git.
3. Inicie a aplicação:

   ```sh
   docker compose up -d --build
   docker compose ps
   ```

   Aguarde o serviço `routiner` ficar saudável. Os dados do PostgreSQL e as fotos são persistidos nos volumes `postgres_data` e `routiner_data`. O banco e a aplicação só escutam na interface local do Debian.
4. Publique o serviço na internet e veja o endereço HTTPS gerado:

   ```sh
   sudo tailscale funnel --bg 8000
   sudo tailscale funnel status
   ```

   Se o comando pedir autorização para Funnel/HTTPS, habilite-a no painel do Tailscale e execute-o novamente. Não configure encaminhamento de portas no roteador.
5. Consulte `sudo tailscale funnel status` para ver o endereço HTTPS público. O instalador desktop usa o endereço padrão configurado em `desktop/main.cjs`; se o endereço do servidor mudar, atualize essa configuração e gere novos instaladores. No celular Android, abra o endereço HTTPS no Chrome e escolha **Instalar app** ou **Adicionar à tela inicial**. O app móvel atual é um PWA servido pelo Debian: ele já se conecta ao mesmo servidor e não exige Tailscale no telefone.

### Instalar os apps nos clientes

O instalador Windows gerado neste projeto usa `DEFAULT_SERVER_URL` em `desktop/main.cjs`, então abre automaticamente o servidor compartilhado. Os clientes não precisam instalar Tailscale nem criar arquivos de configuração. O modo de desenvolvimento (`npm run desktop:dev`) continua usando sua API SQLite local.

No Android, a interface responsiva existente é um PWA: abra o endereço HTTPS do servidor no Chrome e escolha **Instalar app** ou **Adicionar à tela inicial**. O ícone abre o mesmo servidor; não é necessário digitar o endereço novamente. Este projeto ainda não gera APK Android para download. Os usuários precisam de uma conta criada no servidor para entrar; a instalação não cria contas automaticamente.

### Migrar a base local do Windows

Faça backup da base SQLite e das fotos antes de migrar. Feche o Routiner desktop para evitar alterações durante a cópia. No Windows, a base do instalador fica em `%APPDATA%\Routiner\data\routiner.db` e as fotos em `%APPDATA%\Routiner\data\uploads`. Se os dados estiverem na versão de desenvolvimento, use `backend\cleaning.db` e `backend\uploads` como origem.

Faça a migração antes de cadastrar contas no servidor. Para manter o PostgreSQL privado, abra no Windows um túnel SSH para o Debian e deixe esse terminal aberto:

```powershell
ssh -N -L 5433:127.0.0.1:5432 usuario@debian-no-tailscale
```

Em outro PowerShell na pasta do projeto, configure os dados do túnel, do servidor e da base SQLite de origem e execute o importador:

```powershell
$env:DATABASE_URL = "postgresql://routiner:SENHA_DO_POSTGRES@127.0.0.1:5433/routiner"
$env:ROUTINER_MIGRATION_API_URL = "https://debian.exemplo.ts.net"
$env:CLEANING_DB_PATH = "$env:APPDATA\Routiner\data\routiner.db"
$env:CLEANING_UPLOAD_DIR = "$env:APPDATA\Routiner\data\uploads"
.\.venv\Scripts\python.exe backend\migrate_sqlite_to_postgres.py
```

Troque os exemplos pelo usuário SSH do Debian, senha definida no `.env` e URL HTTPS do Funnel. Para a versão de desenvolvimento, aponte `CLEANING_DB_PATH` e `CLEANING_UPLOAD_DIR` para `backend\cleaning.db` e `backend\uploads`. O importador preserva contas e registros e envia as fotos usando a API autenticada; quando houver fotos, ele pedirá a senha da empresa correspondente. Confira o acesso pelo celular e pelo desktop antes de remover qualquer cópia local. O script não sobrescreve linhas conflitantes no destino.

Faça backups periódicos dos volumes Docker. Para listar os nomes: `docker volume ls`; inclua o banco e as fotos no backup e teste a restauração.

## Publicar no Railway para acessar em outros dispositivos

O modo local do app e o modo local do instalador desktop usam SQLite. Para compartilhar os mesmos dados, publique a aplicação web/API e conecte-a a um PostgreSQL persistente:

1. Envie este repositório para o GitHub e crie um projeto no Railway a partir dele. O `Dockerfile` compila a interface e executa a API, que também serve a interface no mesmo endereço.
2. Adicione um serviço PostgreSQL ao projeto e configure a variável `DATABASE_URL` do serviço Routiner para referenciar a URL desse banco (no Railway, use a referência de variável do serviço PostgreSQL).
3. Adicione um volume persistente ao serviço Routiner, montado em `/data`. As fotos ficam em `/data/uploads`; sem o volume, arquivos locais do contêiner podem desaparecer em uma nova implantação.
4. Configure `ROUTINER_AUTH_SECRET` como um segredo aleatório de pelo menos 32 caracteres. Guarde-o no Railway, não no repositório. `ROUTINER_COOKIE_SECURE=true` já é definido pelo contêiner.
5. Gere o domínio público do serviço Routiner. Abra o endereço HTTPS em cada dispositivo e entre com o login/senha existentes no servidor. As contas, funcionários, tarefas, históricos e fotos são lidos e gravados pela API no banco/volume remoto; respostas da API e fotos não são armazenadas em cache. O navegador guarda somente um cookie de sessão seguro (não a senha) e a preferência visual da conta.

O endpoint `/api/health` verifica se o banco está acessível e é usado pelo Railway para health checks. O cadastro feito depois da publicação já será criado no PostgreSQL remoto. Não coloque credenciais do PostgreSQL no frontend.

As rotinas usam o fuso `America/Sao_Paulo` por padrão. Para outro fuso IANA, configure `ROUTINER_TIMEZONE` no serviço da API. O servidor gera as próximas ocorrências automaticamente e marca vencimentos; mantenha uma única instância da API ativa para evitar trabalho duplicado desnecessário.

### Levar os dados locais existentes para o Railway

O banco SQLite do computador e as fotos atuais não são enviados automaticamente ao publicar o app: essa separação evita copiar dados sem autorização e sem escolher a base de origem. Para preservar esses registros, execute o importador **uma única vez** após a implantação, apontando-o para a cópia do banco SQLite que deseja migrar. Ele importa as contas e os registros sem substituir dados já existentes e envia as fotos pela API autenticada.

Configure no terminal de migração as variáveis `DATABASE_URL` (URL pública do PostgreSQL Railway, habilitando acesso público ao banco apenas durante a migração), `ROUTINER_MIGRATION_API_URL` (domínio HTTPS do Routiner), `CLEANING_DB_PATH` (arquivo SQLite de origem) e `CLEANING_UPLOAD_DIR` (pasta `uploads` correspondente à base). Instale as dependências de `backend\requirements.txt` no ambiente Python e execute:

```powershell
.\.venv\Scripts\python.exe backend\migrate_sqlite_to_postgres.py
```

O importador solicita sem ecoar a senha de cada empresa que possui imagens, preserva os identificadores e hashes de senha existentes e faz login para carregar novamente as imagens com o escopo de empresa correto. Mantenha uma cópia de segurança do banco e da pasta de imagens original até confirmar o acesso aos dados no endereço publicado. Se já houver contas/dados na base Railway, linhas conflitantes não são sobrescritas.

## Gerar instalador para Windows

O instalador desktop inclui o aplicativo e uma API Python empacotada; quem instala não precisa instalar Python ou Node.js. O instalador de distribuição usa a URL HTTPS definida em `DEFAULT_SERVER_URL` e conecta ao servidor compartilhado. O modo de desenvolvimento continua local.

Na máquina de desenvolvimento, com Node.js e Python instalados, execute na pasta do projeto:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r backend\requirements-desktop.txt
npm install
npm run desktop:win
```

Se o comando `python` não estiver disponível, substitua-o pelo caminho completo do Python já indicado acima. O instalador final será criado em `release\Routiner-Setup-2.12.0.exe`. Ao iniciá-lo em um computador que já possui o Routiner, a pessoa pode atualizar/reparar para esta versão, desinstalar preservando os dados locais, ou cancelar. Para distribuir, crie uma Release com a tag `v2.12.0` e anexe o arquivo gerado.

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
