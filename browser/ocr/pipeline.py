"""Browser-local OCR stages; inference is supplied by ONNX Runtime Web.

The application parser, avatar registration, and RapidOCR preprocessing are
reused unchanged. No native inference or subprocess is permitted in this module.
"""
from __future__ import annotations

import json
import sys
import time
import types
from pathlib import Path


def _install_web_inference_guard():
    """RapidOCR imports ORT eagerly; its native session is never constructed."""
    if sys.platform != 'emscripten':
        return
    module = types.ModuleType('onnxruntime')

    def unavailable(*args, **kwargs):
        raise RuntimeError('Browser OCR inference must use ONNX Runtime Web.')

    module.GraphOptimizationLevel = types.SimpleNamespace(ORT_ENABLE_ALL=99)
    module.InferenceSession = unavailable
    module.SessionOptions = unavailable
    module.get_available_providers = lambda: ['WebAssemblyExecutionProvider']
    module.get_device = lambda: 'CPU'
    sys.modules['onnxruntime'] = module


_install_web_inference_guard()

import numpy as np
from rapidocr_onnxruntime import RapidOCR
from rapidocr_onnxruntime.ch_ppocr_det.text_detect import TextDetector
from rapidocr_onnxruntime.ch_ppocr_det.utils import DBPostProcess
from rapidocr_onnxruntime.ch_ppocr_rec.text_recognize import TextRecognizer
from rapidocr_onnxruntime.ch_ppocr_rec.utils import CTCLabelDecode


class BrowserOCR:
    def __init__(self, character_list):
        self.detector = TextDetector.__new__(TextDetector)
        self.detector.limit_side_len = 736
        self.detector.limit_type = 'min'
        self.detector.mean = self.detector.std = [0.5, 0.5, 0.5]
        self.detector.postprocess_op = DBPostProcess(
            thresh=.3, box_thresh=.5, max_candidates=1000,
            unclip_ratio=1.6, use_dilation=True, score_mode='fast')
        self.recognizer = TextRecognizer.__new__(TextRecognizer)
        self.recognizer.rec_image_shape = [3, 48, 320]
        self.recognizer.postprocess_op = CTCLabelDecode(character=list(character_list))
        # These methods only implement image transforms and coordinate recovery.
        self.engine = RapidOCR.__new__(RapidOCR)
        self.engine.max_side_len = 2000
        self.engine.min_side_len = 30
        self.engine.min_height = 30
        self.engine.width_height_ratio = 8
        self.engine.text_score = .5
        self.reset()

    def reset(self):
        self.image = self.tile = self.crops = self.tensor = None
        self.boxes = self.rec_results = self.indices = None
        self.rows = []

    def start(self, source, output):
        import importer
        from PIL import Image
        self.reset()
        self.source, self.output = Path(source), Path(output)
        self.started = time.perf_counter()
        with Image.open(self.source) as header:
            width, height = header.size
            if width < 16 or height < 40 or width*height > 80_000_000 or height/width > 60:
                raise ValueError('截图尺寸过大或不完整，请按卡池分成几张图片后导入。')
        self.image = importer._prototype().read_image(self.source)
        self.offsets = [y for y in range(0, self.image.shape[0], 1250)
                        if self.image.shape[0] - y >= 40]
        self.tile_index = 0
        return len(self.offsets)

    def begin_tile(self):
        if self.tile_index >= len(self.offsets):
            self.tensor = None
            return False
        self.offset = self.offsets[self.tile_index]
        tile = self.image[self.offset:min(self.offset+1450, self.image.shape[0])]
        self.raw_h, self.raw_w = tile.shape[:2]
        tile, ratio_h, ratio_w = self.engine.preprocess(tile)
        record = {'preprocess': {'ratio_h': ratio_h, 'ratio_w': ratio_w}}
        self.tile, self.op_record = self.engine.maybe_add_letterbox(tile, record)
        tensor = self.detector.get_preprocess(max(self.tile.shape[:2]))(self.tile)
        if tensor is None:
            raise ValueError('截图尺寸无法用于文字识别。')
        # JS typed arrays cannot describe numpy strides. The detector's CHW
        # transpose is otherwise a non-contiguous view despite its shape.
        self.tensor = np.ascontiguousarray(tensor, dtype=np.float32)
        return True

    def detected(self, data, shape):
        preds = np.asarray(data, dtype=np.float32).reshape(shape)
        boxes, _ = self.detector.postprocess_op(preds, self.tile.shape[:2])
        boxes = self.detector.filter_tag_det_res(boxes, self.tile.shape[:2])
        self.boxes = self.engine.sorted_boxes(boxes) if len(boxes) else []
        self.crops = self.engine.get_crop_img_list(self.tile, self.boxes)
        self.indices = np.argsort(np.array([im.shape[1]/im.shape[0] for im in self.crops]))
        self.rec_results = [('', 0.)] * len(self.crops)
        self.rec_index = 0
        self.tensor = None
        return len(self.crops)

    def begin_recognition(self):
        if self.rec_index >= len(self.crops):
            self.tensor = None
            return False
        self.batch_end = min(len(self.crops), self.rec_index+6)
        chosen = self.indices[self.rec_index:self.batch_end]
        ratio = max(320/48, *(self.crops[i].shape[1]/self.crops[i].shape[0] for i in chosen))
        images = [self.recognizer.resize_norm_img(self.crops[i], ratio)[None, :] for i in chosen]
        self.tensor = np.concatenate(images).astype(np.float32)
        return True

    def recognized(self, data, shape):
        preds = np.asarray(data, dtype=np.float32).reshape(shape)
        result = self.recognizer.postprocess_op(preds, False)
        for position, row in enumerate(result):
            self.rec_results[self.indices[self.rec_index+position]] = row
        self.rec_index = self.batch_end
        self.tensor = None

    def finish_tile(self):
        if self.boxes:
            boxes = self.engine._get_origin_points(self.boxes, self.op_record, self.raw_h, self.raw_w)
            result, _ = self.engine.get_final_res(boxes, None, self.rec_results, 0, 0, 0)
            for points, text, confidence in result or []:
                points = np.array(points)
                points[:, 1] += self.offset
                x0, y0 = points.min(axis=0)
                x1, y1 = points.max(axis=0)
                cx, cy = float((x0+x1)/2), float((y0+y1)/2)
                item = dict(text=text, confidence=float(confidence),
                            box=[float(x0),float(y0),float(x1),float(y1)], x=cx,y=cy)
                duplicate = next((r for r in self.rows if abs(r['y']-cy)<12 and abs(r['x']-cx)<25), None)
                if duplicate is not None:
                    if confidence > duplicate['confidence']:
                        duplicate.update(item)
                else:
                    self.rows.append(item)
        self.tile_index += 1
        self.tile = self.crops = self.tensor = None

    def finish(self):
        import importer
        recognize = importer._prototype()
        rows = sorted(self.rows, key=lambda row:(row['y'],row['x']))
        original_tiles = recognize.ocr_tiles
        # Real inference already ran on these exact pixels in this worker. This
        # callback only delivers its rows to the unchanged application parser.
        recognize.ocr_tiles = lambda engine, image: rows
        ocr_seconds = time.perf_counter()-self.started
        try:
            document = importer.analyze_image(self.source, self.output, engine=object())
        finally:
            recognize.ocr_tiles = original_tiles
        document['timing'].update(ocr_seconds=ocr_seconds,
                                  total_seconds=time.perf_counter()-self.started,
                                  ocr_cache_used=False,
                                  inference_runtime='onnxruntime-web-wasm')
        files = [self.source, *self.output.rglob('*.png')]
        result = {'document':document, 'files':[str(path) for path in files]}
        self.reset()
        return json.dumps(result, ensure_ascii=False, allow_nan=False)


def receive_tensor(values, dimensions):
    """Convert JS typed arrays using the buffer protocol, avoiding JSON copies."""
    return np.asarray(values.to_py() if hasattr(values, 'to_py') else values, dtype=np.float32), list(
        dimensions.to_py() if hasattr(dimensions, 'to_py') else dimensions)
