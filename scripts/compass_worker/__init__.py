"""Job Seeker background worker runtime."""

from .client import ApiError, CompassClient, TaskClaim
from .runner import AdapterResult, TaskAdapter, WorkerRunner

__version__ = "0.1.0"
PROTOCOL_VERSION = 1

__all__ = [
    "AdapterResult",
    "ApiError",
    "CompassClient",
    "TaskAdapter",
    "TaskClaim",
    "WorkerRunner",
    "PROTOCOL_VERSION",
    "__version__",
]
