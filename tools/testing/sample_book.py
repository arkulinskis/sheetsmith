"""Print an example workbook (SampleBooks, the same .xlsm the demo projects use) as JSON {name, b64}.

    python -I tools/testing/sample_book.py tools      -> {"name": "Fernhill Tool Library.xlsm", "b64": "..."}

tools/ui_test.py puts it into flow.js (/*SAMPLE*/), so the UI test can drop a real workbook on the drop zone.
"""
import base64
import json
import pathlib
import shutil
import sys
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
tmp = pathlib.Path(tempfile.mkdtemp(prefix="ss-sample-"))
shutil.copytree(HERE.parents[1] / "server_code", tmp / "app")
(tmp / "app" / "__init__.py").write_text("")
sys.path[:0] = [str(HERE / "mock"), str(tmp)]
from app import SampleBooks  # noqa: E402

name, data = SampleBooks.build(sys.argv[1] if len(sys.argv) > 1 else "tools")
print(json.dumps({"name": name, "b64": base64.b64encode(data).decode()}))
shutil.rmtree(tmp, ignore_errors=True)
