"""Opt-in domain-separated credentials for staged deployment upgrades.

New installations should configure distinct worker and scheduler credentials in
the app and worker environments. Existing installations can supply their prior
domain strings explicitly while both sides move to the neutral public defaults.
"""
import hashlib
import hmac
import os
from typing import Mapping

WORKER_DOMAIN = b"job-seeker:v1:worker:hermes"
SCHEDULER_DOMAIN = b"job-seeker:v1:scheduler"
WORKER_DOMAIN_ENV = "COMPASS_DERIVED_WORKER_DOMAIN"
SCHEDULER_DOMAIN_ENV = "COMPASS_DERIVED_SCHEDULER_DOMAIN"


def _domains(environment: Mapping[str, str]) -> tuple[bytes, bytes]:
    worker = environment.get(WORKER_DOMAIN_ENV, WORKER_DOMAIN.decode("utf-8"))
    scheduler = environment.get(
        SCHEDULER_DOMAIN_ENV, SCHEDULER_DOMAIN.decode("utf-8")
    )
    if (
        not worker.strip()
        or not scheduler.strip()
        or len(worker) > 200
        or len(scheduler) > 200
        or worker == scheduler
    ):
        raise ValueError(
            "Derived worker and scheduler domains must be nonempty, distinct, "
            "and at most 200 characters"
        )
    return worker.encode("utf-8"), scheduler.encode("utf-8")


def derive_credentials(
    app_token: str,
    *,
    environment: Mapping[str, str] | None = None,
) -> tuple[str, str]:
    # Hermes owns exactly one current app credential. Comma-separated rotation
    # lists are a server feature and must not be copied into a worker profile.
    if len(app_token) < 32 or app_token.startswith("op://") or "," in app_token:
        raise ValueError("A single resolved Job Seeker owner key is required")
    domains = _domains(os.environ if environment is None else environment)
    return tuple(hmac.new(app_token.encode(), domain, hashlib.sha256).hexdigest()
                 for domain in domains)
