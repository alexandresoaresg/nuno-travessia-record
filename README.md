# Nuno Travessia Record — Analytics

Dashboard local para acompanhar a Travessia (device **535**) com:

- **Splits por km** no **percurso oficial** (Stop&Go) + categorias de ritmo + bateria
- **Mapa** com trilho GPS colorido por categoria
- **Posição ao vivo** via `position_new` (mais recente) e histórico via `trackersLog` (tipicamente ~1h atrasado)
- **Previsão de chegada** (modelo híbrido) numa secção recolhível

## Requisitos

- Python 3

## Como correr

1) Iniciar o servidor (inclui refresh automático ao abrir a página):

```bash
./serve.sh
```

2) Abrir:

- `http://127.0.0.1:8080`

Ao carregar/recarregar a página, o site chama `GET /api/refresh` (servido por `serve.py`) que executa `refresh_data.py` e volta a carregar `data.js`.

## Atualização manual

```bash
./update.sh
```

## Git automático (dados)

Depois de cada refresh bem-sucedido, o projeto faz **commit + push** dos ficheiros publicados no site:

- `refresh_data.py` → `data.js`, `data.json`, `km_splits.json`
- `refresh_live.py` → `data.js`, `data.json`

Desligar temporariamente:

```bash
export TRAVESSIA_SKIP_GIT_PUBLISH=1   # nenhum commit automático
export TRAVESSIA_AUTO_GIT_LIVE=0      # só refresh completo faz commit (não o live)
python3 refresh_data.py --no-git      # uma execução sem git
python3 refresh_data.py --no-push    # commit local, sem push
```

## Dados e cache

- `cache/`: dados processados usados em modo offline (não versionado)
- `raw/`: dumps originais das respostas da API (não versionado)

## Notas de distância (km 1–9)

Os km são medidos no **percurso oficial** (Stop&Go). Se o primeiro GPS válido cair já perto do km ~10, os km 1–9 aparecem como **sem dados**.

