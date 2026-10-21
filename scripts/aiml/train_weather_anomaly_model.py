#!/usr/bin/env python3
"""
Train a minimal weather anomaly classifier and export ONNX artifact.

Usage:
  python scripts/aiml/train_weather_anomaly_model.py \
    --input data/aiml/weather_anomaly_training.csv \
    --output data/aiml-models/weather-anomaly-v1.onnx
"""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import train_test_split
from sklearn.metrics import classification_report


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, help="CSV with feature columns and is_anomaly label")
    parser.add_argument("--output", required=True, help="Output ONNX model path")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    input_path = Path(args.input)
    output_path = Path(args.output)

    frame = pd.read_csv(input_path)
    if "is_anomaly" not in frame.columns:
        raise ValueError("input dataset must include is_anomaly column")

    X = frame.drop(columns=["is_anomaly"]).astype(float).to_numpy()
    y = frame["is_anomaly"].astype(int).to_numpy()

    X_train, X_test, y_train, y_test = train_test_split(
        X,
        y,
        test_size=0.2,
        random_state=42,
        stratify=y if len(np.unique(y)) > 1 else None,
    )

    model = LogisticRegression(max_iter=400)
    model.fit(X_train, y_train)

    preds = model.predict(X_test)
    print(classification_report(y_test, preds, digits=4))

    try:
      from skl2onnx import convert_sklearn
      from skl2onnx.common.data_types import FloatTensorType
    except Exception as exc:  # pragma: no cover
      raise RuntimeError(
          "skl2onnx is required for ONNX export. Install with: pip install skl2onnx"
      ) from exc

    onnx_model = convert_sklearn(
        model,
        initial_types=[("input", FloatTensorType([None, X.shape[1]]))],
        target_opset=17,
    )

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_bytes(onnx_model.SerializeToString())
    print(f"ONNX model written to {output_path}")


if __name__ == "__main__":
    main()
