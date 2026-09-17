from __future__ import annotations

import json
from pathlib import Path
import unittest

from scripts.compass_worker.credentials import derive_credentials


class DerivedCredentialTest(unittest.TestCase):
    fixture = json.loads(
        (Path(__file__).parents[1] / "fixtures/derived-credentials.json").read_text(
            encoding="utf-8"
        )
    )

    def test_default_vector_matches_the_cross_language_contract(self) -> None:
        expected = self.fixture["default"]
        self.assertEqual(
            derive_credentials(self.fixture["seed"], environment={}),
            (expected["worker"], expected["scheduler"]),
        )

    def test_custom_domain_vector_supports_staged_upgrades(self) -> None:
        domains = self.fixture["customDomains"]
        expected = self.fixture["custom"]
        self.assertEqual(
            derive_credentials(
                self.fixture["seed"],
                environment={
                    "COMPASS_DERIVED_WORKER_DOMAIN": domains["worker"],
                    "COMPASS_DERIVED_SCHEDULER_DOMAIN": domains["scheduler"],
                },
            ),
            (expected["worker"], expected["scheduler"]),
        )

    def test_domains_must_be_nonempty_and_distinct(self) -> None:
        invalid = (
            {
                "COMPASS_DERIVED_WORKER_DOMAIN": "",
                "COMPASS_DERIVED_SCHEDULER_DOMAIN": "scheduler",
            },
            {
                "COMPASS_DERIVED_WORKER_DOMAIN": "worker",
                "COMPASS_DERIVED_SCHEDULER_DOMAIN": "  ",
            },
            {
                "COMPASS_DERIVED_WORKER_DOMAIN": "same",
                "COMPASS_DERIVED_SCHEDULER_DOMAIN": "same",
            },
            {
                "COMPASS_DERIVED_WORKER_DOMAIN": "w" * 201,
                "COMPASS_DERIVED_SCHEDULER_DOMAIN": "scheduler",
            },
        )
        for environment in invalid:
            with self.subTest(environment=environment):
                with self.assertRaisesRegex(ValueError, "domains"):
                    derive_credentials(self.fixture["seed"], environment=environment)


if __name__ == "__main__":
    unittest.main()
