"""Independent SigV4 presigner, written straight from the AWS spec.

Generates test/fixtures/sigv4.json. This deliberately shares no code with
src/sigv4.ts -- agreement between the two is the actual test.
"""
import hashlib, hmac, json, pathlib, urllib.parse

AMZDATE = "20260831T123456Z"
DATESTAMP = "20260831"


def q(s):
    return urllib.parse.quote(s, safe="")


def presign(creds, key, expires, extra, method="GET"):
    endpoint = creds["endpoint"].replace("https://", "").replace("http://", "").rstrip("/")
    host = f"{creds['bucket']}.{endpoint}"
    uri = "/" + "/".join(q(seg) for seg in key.split("/"))
    scope = f"{DATESTAMP}/{creds['region']}/s3/aws4_request"

    params = dict(extra)
    params.update({
        "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
        "X-Amz-Credential": f"{creds['accessKey']}/{scope}",
        "X-Amz-Date": AMZDATE,
        "X-Amz-Expires": str(expires),
        "X-Amz-SignedHeaders": "host",
    })
    if creds.get("sessionToken"):
        params["X-Amz-Security-Token"] = creds["sessionToken"]

    cq = "&".join(f"{q(k)}={q(v)}" for k, v in sorted(params.items()))
    creq = "\n".join([method, uri, cq, f"host:{host}\n", "host", "UNSIGNED-PAYLOAD"])
    sts = "\n".join([
        "AWS4-HMAC-SHA256", AMZDATE, scope,
        hashlib.sha256(creq.encode()).hexdigest(),
    ])

    def h(k, m):
        return hmac.new(k, m.encode(), hashlib.sha256).digest()

    k = h(h(h(h(("AWS4" + creds["secretKey"]).encode(), DATESTAMP),
                creds["region"]), "s3"), "aws4_request")
    sig = hmac.new(k, sts.encode(), hashlib.sha256).hexdigest()
    return f"https://{host}{uri}?{cq}&X-Amz-Signature={sig}"


SCW = {
    "endpoint": "https://s3.fr-par.scw.cloud", "region": "fr-par",
    "bucket": "my-bucket", "accessKey": "SCWXXXXXXXXXXXXXXXXX",
    "secretKey": "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
}
AWS = {**SCW, "endpoint": "https://s3.eu-west-1.amazonaws.com", "region": "eu-west-1"}
TEMP = {**SCW, "sessionToken": "FQoDYXdzEC//////////wEaDNotAReal+Token/w=="}
JPEG = {"response-content-type": "image/jpeg"}

CASES = [
    ("scaleway plain photo", SCW, "2022/08/29/IMG_1234.jpg", 3600, {}, "GET"),
    ("endpoint with trailing slash", {**SCW, "endpoint": "https://s3.fr-par.scw.cloud/"},
     "2022/08/29/IMG_1234.jpg", 3600, {}, "GET"),
    ("bare host endpoint", {**SCW, "endpoint": "s3.fr-par.scw.cloud"},
     "2022/08/29/IMG_1234.jpg", 3600, {}, "GET"),
    ("aws regression", AWS, "2022/08/29/IMG_1234.jpg", 3600, {}, "GET"),
    ("awkward characters in key", SCW, "2022/08/29/café (1) & co!.jpg", 300, {}, "GET"),
    ("session token with / + =", TEMP, "2022/08/29/IMG_1234.jpg", 300, {}, "GET"),
    ("thumbnail with content-type override", SCW,
     ".thumbs/2022/08/29/IMG_1234.jpg", 3600, JPEG, "GET"),
    ("video thumbnail with content-type override", SCW,
     ".thumbs/2022/08/29/VID_0001.mp4", 3600, JPEG, "GET"),
    ("override plus session token", TEMP, ".thumbs/2022/08/29/VID_0001.mp4", 3600, JPEG, "GET"),

    # DELETE. Only the first line of the canonical request changes, so these
    # share keys with the GET cases above -- a signature that matches its GET
    # twin would mean the method never reached the string being signed.
    ("delete an original", SCW, "2022/08/29/IMG_1234.jpg", 3600, {}, "DELETE"),
    ("delete a thumbnail", SCW, ".thumbs/2022/08/29/IMG_1234.jpg", 3600, {}, "DELETE"),
    ("delete a video", SCW, "2022/08/29/VID_0001.mp4", 300, {}, "DELETE"),
    ("delete with awkward characters", SCW, "2022/08/29/café (1) & co!.jpg", 300, {}, "DELETE"),
    ("delete with a session token", TEMP, "2022/08/29/IMG_1234.jpg", 300, {}, "DELETE"),
    ("delete against aws", AWS, "2022/08/29/IMG_1234.jpg", 3600, {}, "DELETE"),
]

out = [
    {"name": n, "creds": c, "key": k, "expires": e, "query": x, "method": m,
     "amzDate": AMZDATE, "url": presign(c, k, e, x, m)}
    for n, c, k, e, x, m in CASES
]
path = pathlib.Path("test/fixtures/sigv4.json")
path.write_text(json.dumps(out, indent=2, ensure_ascii=False) + chr(10), encoding="utf-8")
print(f"{len(out)} fixtures -> {path}")
