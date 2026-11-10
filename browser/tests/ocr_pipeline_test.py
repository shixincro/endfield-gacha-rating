"""Opt-in OCR stage parity check; screenshots are supplied locally, not fixtures.

python browser/tests/ocr_pipeline_test.py --image /path/to/image --output /tmp/check
This verifies the split pipeline with native ORT. Browser WASM is checked by
the separate browser integration test; this test does not claim browser QA.
"""
from __future__ import annotations
import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT/'tools/gacha_rating_app'))
sys.path.insert(0, str(ROOT/'browser/ocr'))


def semantic_document(doc):
    ignored = {'sourcePath','rawOcrPath','crop','timing','sourceImage','file','avatar_match'}
    def clean(value):
        if isinstance(value, dict):
            return {key:clean(child) for key,child in value.items() if key not in ignored}
        if isinstance(value, list):
            return [clean(child) for child in value]
        return value
    return clean(doc)


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--image', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args=parser.parse_args()
    import importer
    import onnxruntime as ort
    from pipeline import BrowserOCR
    from rapidocr_onnxruntime import __file__ as package_file
    models=Path(package_file).parent/'models'
    options=ort.SessionOptions()
    options.intra_op_num_threads=2
    options.inter_op_num_threads=1
    det=ort.InferenceSession(str(models/'ch_PP-OCRv4_det_infer.onnx'), options, providers=['CPUExecutionProvider'])
    rec=ort.InferenceSession(str(models/'ch_PP-OCRv4_rec_infer.onnx'), options, providers=['CPUExecutionProvider'])
    pipeline=BrowserOCR(rec.get_modelmeta().custom_metadata_map['character'].splitlines())
    count=pipeline.start(args.image, args.output/'split')
    for index in range(count):
        print(f'Tile {index+1}/{count}', flush=True)
        assert pipeline.begin_tile()
        prediction=det.run(None,{det.get_inputs()[0].name:pipeline.tensor})[0]
        pipeline.detected(prediction, prediction.shape)
        while pipeline.begin_recognition():
            prediction=rec.run(None,{rec.get_inputs()[0].name:pipeline.tensor})[0]
            pipeline.recognized(prediction, prediction.shape)
        pipeline.finish_tile()
    split=json.loads(pipeline.finish())['document']
    baseline=importer.analyze_image(args.image,args.output/'baseline')
    report={'matching':semantic_document(split)==semantic_document(baseline),
            'splitOverview':split['overview'],'baselineOverview':baseline['overview'],
            'splitPools':len(split['pools']),'baselinePools':len(baseline['pools'])}
    (args.output/'comparison.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(report,ensure_ascii=False))
    assert report['matching'], 'Split pipeline changed recognized document semantics'


if __name__=='__main__':
    main()
