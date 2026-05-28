# Histórico de previsões

Cada execução de `refresh_data.py` acrescenta uma linha a `predictions.jsonl` e actualiza `latest_snapshot.json`.

## Campos principais

| Campo | Descrição |
|-------|-----------|
| `recordedAt` | Momento em que o snapshot foi gravado |
| `current` | Km, restante, último split |
| `model` | Versão, parâmetros e caps do modelo v4 |
| `performance` | Ritmos, paragens, fadiga medidos no GPS |
| `scenarios` | Chegadas optimista / principal / pessimista |
| `confidence` | % calculada (espelha o tab Objetivos) |
| `proven` | Km/dia demonstrados (global, 40 h, ponderado) |
| `forecastSample` | Primeiros pontos da curva projectada |

## Uso para calibrar o modelo

```bash
# últimas 20 entradas
tail -20 history/predictions.jsonl | python3 -m json.tool

# análise com pandas (exemplo)
python3 -c "
import json, pandas as pd
rows = [json.loads(l) for l in open('history/predictions.jsonl')]
df = pd.json_normalize(rows)
print(df[['recordedAt','current.km','confidence.calendar.pct','scenarios.main.kmPerDay']].tail())
"
```

Ficheiros rotacionados (>12 MB) ficam em `predictions_YYYYMMDD_HHMMSS.jsonl` com índice em `archive_index.txt`.
