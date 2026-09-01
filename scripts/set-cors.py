#!/usr/bin/env python
"""
Add a CORS rule to an S3 bucket without clobbering the rules already there.

put-bucket-cors replaces the whole configuration, so this reads the current
one first, writes it to a backup file, merges in a read-only rule for the
given origin, and only then applies -- and only if you pass --apply.

Pass --allow-delete to add DELETE to the rule, which the viewer needs before
it can delete photos. An origin that already has a read-only rule gets DELETE
added to that rule, unless other origins share it -- widening a shared rule
would grant them DELETE too, so that case stops and says so.

    python scripts/set-cors.py --bucket brj-immich --origin http://localhost:8080
    python scripts/set-cors.py --bucket brj-immich --origin http://localhost:8080 --apply
    python scripts/set-cors.py --profile scaleway --bucket brj-immich \
        --origin http://localhost:8080 --allow-delete --apply
"""

import argparse
import json
import os
import shutil
import subprocess
import sys

BACKUP = "cors-backup.json"

# The installer adds aws to PATH, but only for shells started afterwards.
FALLBACKS = [
    os.path.join("C:", os.sep, "Program Files", "Amazon", "AWSCLIV2", "aws.exe"),
    os.path.join("C:", os.sep, "Program Files (x86)", "Amazon", "AWSCLIV2", "aws.exe"),
]


def find_aws(override=None):
    for candidate in [override] if override else [shutil.which("aws")] + FALLBACKS:
        if candidate and os.path.exists(candidate):
            return candidate
        if candidate and shutil.which(candidate):
            return candidate
    sys.exit("Could not find the aws CLI. Open a new shell, or pass --aws-bin "
             "with the full path to aws.exe.")


def aws(args, endpoint, bucket, profile=None, binary="aws"):
    """Run an aws s3api command, returning (ok, stdout, stderr)."""
    cmd = [binary, "s3api", args[0], "--bucket", bucket, "--endpoint-url", endpoint] + args[1:]
    if profile:
        cmd += ["--profile", profile]
    p = subprocess.run(cmd, capture_output=True, text=True)
    return p.returncode == 0, p.stdout.strip(), p.stderr.strip()


def current_rules(endpoint, bucket, profile, binary):
    """Existing CORSRules, or None if the bucket has no configuration."""
    ok, out, err = aws(["get-bucket-cors"], endpoint, bucket, profile, binary)
    if ok:
        return json.loads(out).get("CORSRules", [])
    if "NoSuchCORSConfiguration" in err:
        return None
    sys.exit("Could not read current CORS config:\n" + err)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bucket", required=True)
    ap.add_argument("--origin", required=True, help="exact scheme://host:port, no trailing slash")
    ap.add_argument("--endpoint", default="https://s3.fr-par.scw.cloud")
    ap.add_argument("--profile", help="aws CLI profile to use (e.g. scaleway)")
    ap.add_argument("--aws-bin", help="path to aws.exe if it is not on PATH")
    ap.add_argument("--allow-delete", action="store_true",
                    help="also allow DELETE, so the viewer can delete photos")
    ap.add_argument("--apply", action="store_true", help="actually write; otherwise dry run")
    a = ap.parse_args()

    if a.origin.endswith("/"):
        sys.exit("Origin must not end with a slash -- browsers send it without one.")

    binary = find_aws(a.aws_bin)
    existing = current_rules(a.endpoint, a.bucket, a.profile, binary)

    if existing is None:
        print("No CORS configuration on this bucket yet. Nothing to preserve.")
        existing = []
    else:
        with open(BACKUP, "w") as f:
            json.dump({"CORSRules": existing}, f, indent=2)
        print("Existing config (%d rule(s)) backed up to %s" % (len(existing), BACKUP))
        print("  Restore with: aws s3api put-bucket-cors --bucket %s \\" % a.bucket)
        print("      --endpoint-url %s --cors-configuration file://%s" % (a.endpoint, BACKUP))

    wanted = ["GET", "HEAD"] + (["DELETE"] if a.allow_delete else [])
    mine = [r for r in existing if a.origin in r.get("AllowedOrigins", [])]

    if mine:
        # "Already allowed" has to mean "allowed for the methods we want".
        # Matching on the origin alone would make --allow-delete a no-op on
        # exactly the buckets it is for: the ones already serving the viewer
        # through a read-only rule.
        gaps = [(r, [m for m in wanted if m not in r.get("AllowedMethods", [])])
                for r in mine]
        if any(not gap for _, gap in gaps):
            print("\n%s is already allowed for %s. Nothing to do."
                  % (a.origin, ", ".join(wanted)))
            return

        rule, gap = gaps[0]
        shared = [o for o in rule.get("AllowedOrigins", []) if o != a.origin]
        if shared:
            sys.exit(
                "\nThe rule allowing %s also covers: %s\n"
                "Adding %s to it would grant those origins too, so this script "
                "will not do it.\nSplit that rule by hand, or drop %s from it "
                "and re-run to get a rule of its own."
                % (a.origin, ", ".join(shared), ", ".join(gap), a.origin))

        rule["AllowedMethods"] = rule.get("AllowedMethods", []) + gap
        merged = existing
        print("\nConfiguration to apply (adding %s to the existing rule for %s):"
              % (", ".join(gap), a.origin))
    else:
        merged = existing + [{
            "AllowedOrigins": [a.origin],
            "AllowedHeaders": ["*"],
            "AllowedMethods": wanted,
            "MaxAgeSeconds": 3000,
            "ExposeHeaders": ["Etag"],
        }]
        print("\nConfiguration to apply (%d existing rule(s) kept, 1 added):"
              % len(existing))

    print(json.dumps({"CORSRules": merged}, indent=2))

    if not a.apply:
        print("\nDry run. Re-run with --apply to write this.")
        return

    with open("cors-merged.json", "w") as f:
        json.dump({"CORSRules": merged}, f, indent=2)

    ok, _, err = aws(
        ["put-bucket-cors", "--cors-configuration", "file://cors-merged.json"],
        a.endpoint, a.bucket, a.profile, binary,
    )
    if not ok:
        sys.exit("Failed to apply:\n" + err +
                 "\n\nAccessDenied here means the key lacks the "
                 "ObjectStorageBucketsWrite IAM permission. Nothing was changed.")

    print("\nApplied. Verifying...")
    ok, out, err = aws(["get-bucket-cors"], a.endpoint, a.bucket, a.profile, binary)
    print(out if ok else err)


if __name__ == "__main__":
    main()
