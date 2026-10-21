# AI/ML Image Classification Model Setup

This service uses the AI/ML model registry endpoint at `POST /api/ai/models` and the image classification endpoint at `POST /api/aiml/image/classify`.

## 1) Download or prepare an ONNX classifier

Use any small weather-image ONNX classifier and place it under:

- `backend/data/aiml-models/weather-image-classifier.onnx`

Do not commit large model binaries to git.

## 2) Register model

```bash
curl -X POST http://localhost:6001/api/ai/models \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "weather-image-classifier",
    "version": "1.0.0",
    "network": "near",
    "model_type": "weather_image_classification",
    "file_path": "weather-image-classifier.onnx",
    "labels": ["clear_sky","cloudy","rain","storm","snow","fog"]
  }'
```

## 3) Classify image

```bash
curl -X POST http://localhost:6001/api/aiml/image/classify \
  -F image=@./sample-storm.png \
  -F station_id=KSEA \
  -F region_id=pnw \
  -F captured_at=2026-03-05T12:00:00Z
```

If ONNX runtime or model loading is unavailable, endpoint returns deterministic fallback output with `model.fallback_used: true`.
