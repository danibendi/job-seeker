#!/usr/bin/env python3
"""Non-mutating checks for the Hermes adapter's staging invariants."""

from __future__ import annotations

import argparse
from pathlib import Path

import yaml


class StrictSafeLoader(yaml.SafeLoader):
    """Safe YAML loader that rejects ambiguous duplicate mapping keys."""


def _strict_mapping(loader: StrictSafeLoader, node: yaml.MappingNode, deep: bool = False):
    mapping = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node, deep=deep)
        try:
            duplicate = key in mapping
        except TypeError:
            raise yaml.constructor.ConstructorError(
                "while constructing a mapping", node.start_mark,
                "found an unhashable mapping key", key_node.start_mark,
            ) from None
        if duplicate:
            raise yaml.constructor.ConstructorError(
                "while constructing a mapping", node.start_mark,
                f"found duplicate key {key!r}", key_node.start_mark,
            )
        mapping[key] = loader.construct_object(value_node, deep=deep)
    return mapping


StrictSafeLoader.add_constructor(
    yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG,
    _strict_mapping,
)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--profiles-dir", type=Path, required=True)
    parser.add_argument("--profile", default="compass-worker")
    parser.add_argument("--staging-profile", default="compass-worker-staging")
    parser.add_argument("--root-config", type=Path, required=True)
    args = parser.parse_args()

    if args.profile == args.staging_profile:
        raise SystemExit("Profile and staging profile must differ")
    profile_candidates = [
        args.profiles_dir / args.profile,
        args.profiles_dir / f"{args.profile}.yaml",
        args.profiles_dir / f"{args.profile}.yml",
    ]
    if not any(path.exists() for path in profile_candidates):
        raise SystemExit(f"Hermes profile {args.profile!r} is missing")
    staging_candidates = [
        args.profiles_dir / args.staging_profile,
        args.profiles_dir / f"{args.staging_profile}.yaml",
        args.profiles_dir / f"{args.staging_profile}.yml",
    ]
    present = [str(path) for path in staging_candidates if path.exists()]
    if present:
        raise SystemExit("Staging profile must not exist: " + ", ".join(present))
    try:
        root = yaml.load(args.root_config.read_text(encoding="utf-8"), Loader=StrictSafeLoader)
    except OSError as error:
        raise SystemExit(f"Could not read root config: {error}") from None
    except yaml.YAMLError:
        raise SystemExit("Root config is invalid or ambiguous YAML") from None
    if not isinstance(root, dict):
        raise SystemExit("Root config must be a YAML mapping")
    kanban = root.get("kanban")
    if not isinstance(kanban, dict) or kanban.get("dispatch_in_gateway") is not False:
        raise SystemExit("Root config must set kanban.dispatch_in_gateway to false")
    print(
        f"ready: profile={args.profile} staging_absent={args.staging_profile} "
        "gateway_dispatch=false"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
