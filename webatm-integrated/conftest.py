"""Pytest bootstrap for the webatm-integrated package.

Puts this directory on sys.path so `import webatm_integrated` works when running
`pytest webatm-integrated/tests` from the repo root without installing the
package first, and adds the repo root so integrated modules can `import WebATM.*`
(the runtime image provides the core package on PYTHONPATH the same way).
"""

import os
import sys

_here = os.path.dirname(__file__)
sys.path.insert(0, _here)  # `import webatm_integrated`
sys.path.insert(0, os.path.dirname(_here))  # repo root: `import WebATM`
