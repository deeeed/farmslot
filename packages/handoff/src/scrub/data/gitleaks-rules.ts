/**
 * Ported gitleaks vendor detector rules - GENERATED, do not edit by hand.
 * Regenerate with: node scripts/generate-gitleaks-rules.mjs <gitleaks.toml> <commit>
 *
 * Source: gitleaks default ruleset (https://github.com/gitleaks/gitleaks,
 * config/gitleaks.toml @ 09242ce9c8a60d9b051fc2d166f9e849b88c7ac0). Licensed MIT.
 *
 * MIT License, Copyright (c) 2019 Zachary Rice (gitleaks). Full text:
 * https://github.com/gitleaks/gitleaks/blob/master/LICENSE
 *
 * Ported: 219 vendor rules. Skipped generic high-entropy rules and
 * any rule that could not convert to JS or tripped the clean-prose guard (see
 * the generator's run summary). These rules run THROUGH the floor's JSON-unescape
 * pipeline and are UNION-only additions over the hand-authored floor - they
 * never narrow existing coverage.
 */

export interface GitleaksRule {
  /** The gitleaks rule id, used as the floor hit `kind`. */
  kind: string;
  /** The detector pattern (Go/RE2 converted to JS; global flag applied at use). */
  pattern: RegExp;
}

export const GITLEAKS_RULES: GitleaksRule[] = [
  {
    kind: 'gitleaks:1password-secret-key',
    pattern: new RegExp(
      '\\bA3-[A-Z0-9]{6}-(?:(?:[A-Z0-9]{11})|(?:[A-Z0-9]{6}-[A-Z0-9]{5}))-[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}\\b',
      'g',
    ),
  },
  {
    kind: 'gitleaks:1password-service-account-token',
    pattern: new RegExp('ops_eyJ[a-zA-Z0-9+/]{250,}={0,3}', 'g'),
  },
  {
    kind: 'gitleaks:adafruit-api-key',
    pattern: new RegExp(
      '[\\w.-]{0,50}?(?:adafruit)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-z0-9_-]{32})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'gi',
    ),
  },
  {
    kind: 'gitleaks:adobe-client-id',
    pattern: new RegExp(
      '[\\w.-]{0,50}?(?:adobe)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-f0-9]{32})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'gi',
    ),
  },
  {
    kind: 'gitleaks:adobe-client-secret',
    pattern: new RegExp('\\b(p8e-[a-z0-9]{32})(?:[\\x60\'"\\s;]|\\\\[nr]|$)', 'gi'),
  },
  {
    kind: 'gitleaks:age-secret-key',
    pattern: new RegExp('AGE-SECRET-KEY-1[QPZRY9X8GF2TVDW0S3JN54KHCE6MUA7L]{58}', 'g'),
  },
  {
    kind: 'gitleaks:airtable-api-key',
    pattern: new RegExp(
      '[\\w.-]{0,50}?(?:airtable)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-z0-9]{17})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'gi',
    ),
  },
  {
    kind: 'gitleaks:airtable-personnal-access-token',
    pattern: new RegExp('\\b(pat[A-Za-z0-9]{14}\\.[a-f0-9]{64})\\b', 'g'),
  },
  {
    kind: 'gitleaks:algolia-api-key',
    pattern: new RegExp(
      '[\\w.-]{0,50}?(?:algolia)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-z0-9]{32})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'gi',
    ),
  },
  {
    kind: 'gitleaks:alibaba-access-key-id',
    pattern: new RegExp('\\b(LTAI[a-z0-9]{20})(?:[\\x60\'"\\s;]|\\\\[nr]|$)', 'gi'),
  },
  {
    kind: 'gitleaks:alibaba-secret-key',
    pattern: new RegExp(
      '[\\w.-]{0,50}?(?:alibaba)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-z0-9]{30})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'gi',
    ),
  },
  {
    kind: 'gitleaks:anthropic-admin-api-key',
    pattern: new RegExp(
      '\\b(sk-ant-admin01-[a-zA-Z0-9_\\-]{93}AA)(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'g',
    ),
  },
  {
    kind: 'gitleaks:anthropic-api-key',
    pattern: new RegExp(
      '\\b(sk-ant-api03-[a-zA-Z0-9_\\-]{93}AA)(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'g',
    ),
  },
  { kind: 'gitleaks:artifactory-api-key', pattern: new RegExp('\\bAKCp[A-Za-z0-9]{69}\\b', 'g') },
  {
    kind: 'gitleaks:artifactory-reference-token',
    pattern: new RegExp('\\bcmVmd[A-Za-z0-9]{59}\\b', 'g'),
  },
  {
    kind: 'gitleaks:asana-client-id',
    pattern: new RegExp(
      '[\\w.-]{0,50}?(?:asana)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([0-9]{16})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'gi',
    ),
  },
  {
    kind: 'gitleaks:asana-client-secret',
    pattern: new RegExp(
      '[\\w.-]{0,50}?(?:asana)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-z0-9]{32})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'gi',
    ),
  },
  {
    kind: 'gitleaks:atlassian-api-token',
    pattern: new RegExp(
      '[\\w.-]{0,50}?(?:(?:ATLASSIAN|[Aa]tlassian)|(?:CONFLUENCE|[Cc]onfluence)|(?:JIRA|[Jj]ira))(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-z0-9]{20}[a-f0-9]{4})(?:[\\x60\'"\\s;]|\\\\[nr]|$)|\\b(ATATT3[A-Za-z0-9_\\-=]{186})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'gi',
    ),
  },
  {
    kind: 'gitleaks:authress-service-client-access-key',
    pattern: new RegExp(
      '\\b((?:sc|ext|scauth|authress)_[a-z0-9]{5,30}\\.[a-z0-9]{4,6}\\.(?:acc)[_-][a-z0-9-]{10,32}\\.[a-z0-9+/_=-]{30,120})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'gi',
    ),
  },
  {
    kind: 'gitleaks:aws-access-token',
    pattern: new RegExp('\\b((?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16})\\b', 'g'),
  },
  {
    kind: 'gitleaks:aws-amazon-bedrock-api-key-long-lived',
    pattern: new RegExp('\\b(ABSK[A-Za-z0-9+/]{109,269}={0,2})(?:[\\x60\'"\\s;]|\\\\[nr]|$)', 'g'),
  },
  {
    kind: 'gitleaks:aws-amazon-bedrock-api-key-short-lived',
    pattern: new RegExp('bedrock-api-key-YmVkcm9jay5hbWF6b25hd3MuY29t', 'g'),
  },
  {
    kind: 'gitleaks:azure-ad-client-secret',
    pattern: new RegExp(
      '(?:^|[\\\\\'"\\x60\\s>=:(,)])([a-zA-Z0-9_~.]{3}\\dQ~[a-zA-Z0-9_~.-]{31,34})(?:$|[\\\\\'"\\x60\\s<),])',
      'g',
    ),
  },
  {
    kind: 'gitleaks:beamer-api-token',
    pattern: new RegExp(
      '[\\w.-]{0,50}?(?:beamer)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}(b_[a-z0-9=_\\-]{44})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'gi',
    ),
  },
  {
    kind: 'gitleaks:bitbucket-client-id',
    pattern: new RegExp(
      '[\\w.-]{0,50}?(?:bitbucket)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-z0-9]{32})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'gi',
    ),
  },
  {
    kind: 'gitleaks:bitbucket-client-secret',
    pattern: new RegExp(
      '[\\w.-]{0,50}?(?:bitbucket)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-z0-9=_\\-]{64})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'gi',
    ),
  },
  {
    kind: 'gitleaks:bittrex-access-key',
    pattern: new RegExp(
      '[\\w.-]{0,50}?(?:bittrex)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-z0-9]{32})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'gi',
    ),
  },
  {
    kind: 'gitleaks:bittrex-secret-key',
    pattern: new RegExp(
      '[\\w.-]{0,50}?(?:bittrex)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-z0-9]{32})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'gi',
    ),
  },
  {
    kind: 'gitleaks:cisco-meraki-api-key',
    pattern: new RegExp(
      '[\\w.-]{0,50}?(?:[\\w.-]{0,50}?(?:(?:[Mm]eraki|MERAKI))(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3})(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([0-9a-f]{40})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'g',
    ),
  },
  {
    kind: 'gitleaks:clickhouse-cloud-api-secret-key',
    pattern: new RegExp('\\b(4b1d[A-Za-z0-9]{38})\\b', 'g'),
  },
  { kind: 'gitleaks:clojars-api-token', pattern: new RegExp('CLOJARS_[a-z0-9]{60}', 'gi') },
  {
    kind: 'gitleaks:cloudflare-api-key',
    pattern: new RegExp(
      '[\\w.-]{0,50}?(?:cloudflare)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-z0-9_-]{40})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'gi',
    ),
  },
  {
    kind: 'gitleaks:cloudflare-global-api-key',
    pattern: new RegExp(
      '[\\w.-]{0,50}?(?:cloudflare)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-f0-9]{37})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'gi',
    ),
  },
  {
    kind: 'gitleaks:cloudflare-origin-ca-key',
    pattern: new RegExp('\\b(v1\\.0-[a-f0-9]{24}-[a-f0-9]{146})(?:[\\x60\'"\\s;]|\\\\[nr]|$)', 'g'),
  },
  {
    kind: 'gitleaks:codecov-access-token',
    pattern: new RegExp(
      '[\\w.-]{0,50}?(?:codecov)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-z0-9]{32})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'gi',
    ),
  },
  {
    kind: 'gitleaks:cohere-api-token',
    pattern: new RegExp(
      '[\\w.-]{0,50}?(?:[\\w.-]{0,50}?(?:cohere|CO_API_KEY)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3})(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-zA-Z0-9]{40})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'g',
    ),
  },
  {
    kind: 'gitleaks:coinbase-access-token',
    pattern: new RegExp(
      '[\\w.-]{0,50}?(?:coinbase)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-z0-9_-]{64})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'gi',
    ),
  },
  {
    kind: 'gitleaks:confluent-access-token',
    pattern: new RegExp(
      '[\\w.-]{0,50}?(?:confluent)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-z0-9]{16})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'gi',
    ),
  },
  {
    kind: 'gitleaks:confluent-secret-key',
    pattern: new RegExp(
      '[\\w.-]{0,50}?(?:confluent)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-z0-9]{64})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'gi',
    ),
  },
  {
    kind: 'gitleaks:contentful-delivery-api-token',
    pattern: new RegExp(
      '[\\w.-]{0,50}?(?:contentful)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-z0-9=_\\-]{43})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'gi',
    ),
  },
  {
    kind: 'gitleaks:curl-auth-header',
    pattern: new RegExp(
      '\\bcurl\\b(?:.*?|.*?(?:[\\r\\n]{1,2}.*?){1,5})[ \\t\\n\\r](?:-H|--header)(?:=|[ \\t]{0,5})(?:"(?:Authorization:[ \\t]{0,5}(?:Basic[ \\t]([a-z0-9+/]{8,}={0,3})|(?:Bearer|(?:Api-)?Token)[ \\t]([\\w=~@.+/-]{8,})|([\\w=~@.+/-]{8,}))|(?:(?:X-(?:[a-z]+-)?)?(?:Api-?)?(?:Key|Token)):[ \\t]{0,5}([\\w=~@.+/-]{8,}))"|\'(?:Authorization:[ \\t]{0,5}(?:Basic[ \\t]([a-z0-9+/]{8,}={0,3})|(?:Bearer|(?:Api-)?Token)[ \\t]([\\w=~@.+/-]{8,})|([\\w=~@.+/-]{8,}))|(?:(?:X-(?:[a-z]+-)?)?(?:Api-?)?(?:Key|Token)):[ \\t]{0,5}([\\w=~@.+/-]{8,}))\')(?:\\B|\\s|\\z)',
      'gi',
    ),
  },
  {
    kind: 'gitleaks:curl-auth-user',
    pattern: new RegExp(
      '\\bcurl\\b(?:.*|.*(?:[\\r\\n]{1,2}.*){1,5})[ \\t\\n\\r](?:-u|--user)(?:=|[ \\t]{0,5})("(:[^"]{3,}|[^:"]{3,}:|[^:"]{3,}:[^"]{3,})"|\'([^:\']{3,}:[^\']{3,})\'|((?:"[^"]{3,}"|\'[^\']{3,}\'|[\\w$@.-]+):(?:"[^"]{3,}"|\'[^\']{3,}\'|[\\w${}@.-]+)))(?:\\s|\\z)',
      'g',
    ),
  },
  {
    kind: 'gitleaks:databricks-api-token',
    pattern: new RegExp('\\b(dapi[a-f0-9]{32}(?:-\\d)?)(?:[\\x60\'"\\s;]|\\\\[nr]|$)', 'g'),
  },
  {
    kind: 'gitleaks:datadog-access-token',
    pattern: new RegExp(
      '[\\w.-]{0,50}?(?:datadog)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-z0-9]{40})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'gi',
    ),
  },
  {
    kind: 'gitleaks:defined-networking-api-token',
    pattern: new RegExp(
      '[\\w.-]{0,50}?(?:dnkey)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}(dnkey-[a-z0-9=_\\-]{26}-[a-z0-9=_\\-]{52})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'gi',
    ),
  },
  {
    kind: 'gitleaks:digitalocean-access-token',
    pattern: new RegExp('\\b(doo_v1_[a-f0-9]{64})(?:[\\x60\'"\\s;]|\\\\[nr]|$)', 'g'),
  },
  {
    kind: 'gitleaks:digitalocean-pat',
    pattern: new RegExp('\\b(dop_v1_[a-f0-9]{64})(?:[\\x60\'"\\s;]|\\\\[nr]|$)', 'g'),
  },
  {
    kind: 'gitleaks:digitalocean-refresh-token',
    pattern: new RegExp('\\b(dor_v1_[a-f0-9]{64})(?:[\\x60\'"\\s;]|\\\\[nr]|$)', 'gi'),
  },
  {
    kind: 'gitleaks:discord-api-token',
    pattern: new RegExp(
      '[\\w.-]{0,50}?(?:discord)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-f0-9]{64})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'gi',
    ),
  },
  {
    kind: 'gitleaks:discord-client-id',
    pattern: new RegExp(
      '[\\w.-]{0,50}?(?:discord)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([0-9]{18})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'gi',
    ),
  },
  {
    kind: 'gitleaks:discord-client-secret',
    pattern: new RegExp(
      '[\\w.-]{0,50}?(?:discord)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-z0-9=_\\-]{32})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'gi',
    ),
  },
  { kind: 'gitleaks:doppler-api-token', pattern: new RegExp('dp\\.pt\\.[a-z0-9]{43}', 'gi') },
  {
    kind: 'gitleaks:droneci-access-token',
    pattern: new RegExp(
      '[\\w.-]{0,50}?(?:droneci)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-z0-9]{32})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'gi',
    ),
  },
  {
    kind: 'gitleaks:dropbox-api-token',
    pattern: new RegExp(
      '[\\w.-]{0,50}?(?:dropbox)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-z0-9]{15})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'gi',
    ),
  },
  {
    kind: 'gitleaks:dropbox-long-lived-api-token',
    pattern: new RegExp(
      '[\\w.-]{0,50}?(?:dropbox)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-z0-9]{11}(AAAAAAAAAA)[a-z0-9\\-_=]{43})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'gi',
    ),
  },
  {
    kind: 'gitleaks:dropbox-short-lived-api-token',
    pattern: new RegExp(
      '[\\w.-]{0,50}?(?:dropbox)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}(sl\\.[a-z0-9\\-=_]{135})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'gi',
    ),
  },
  {
    kind: 'gitleaks:duffel-api-token',
    pattern: new RegExp('duffel_(?:test|live)_[a-z0-9_\\-=]{43}', 'gi'),
  },
  {
    kind: 'gitleaks:dynatrace-api-token',
    pattern: new RegExp('dt0c01\\.[a-z0-9]{24}\\.[a-z0-9]{64}', 'gi'),
  },
  { kind: 'gitleaks:easypost-api-token', pattern: new RegExp('\\bEZAK[a-z0-9]{54}\\b', 'gi') },
  { kind: 'gitleaks:easypost-test-api-token', pattern: new RegExp('\\bEZTK[a-z0-9]{54}\\b', 'gi') },
  {
    kind: 'gitleaks:etsy-access-token',
    pattern: new RegExp(
      '[\\w.-]{0,50}?(?:(?:ETSY|[Ee]tsy))(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-z0-9]{24})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'gi',
    ),
  },
  {
    kind: 'gitleaks:facebook-access-token',
    pattern: new RegExp(
      '\\b(\\d{15,16}(\\||%)[0-9a-z\\-_]{27,40})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'gi',
    ),
  },
  {
    kind: 'gitleaks:facebook-page-access-token',
    pattern: new RegExp('\\b(EAA[MC][a-z0-9]{100,})(?:[\\x60\'"\\s;]|\\\\[nr]|$)', 'gi'),
  },
  {
    kind: 'gitleaks:facebook-secret',
    pattern: new RegExp(
      '[\\w.-]{0,50}?(?:facebook)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-f0-9]{32})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'gi',
    ),
  },
  {
    kind: 'gitleaks:fastly-api-token',
    pattern: new RegExp(
      '[\\w.-]{0,50}?(?:fastly)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-z0-9=_\\-]{32})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'gi',
    ),
  },
  {
    kind: 'gitleaks:finicity-api-token',
    pattern: new RegExp(
      '[\\w.-]{0,50}?(?:finicity)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-f0-9]{32})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'gi',
    ),
  },
  {
    kind: 'gitleaks:finicity-client-secret',
    pattern: new RegExp(
      '[\\w.-]{0,50}?(?:finicity)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-z0-9]{20})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'gi',
    ),
  },
  {
    kind: 'gitleaks:finnhub-access-token',
    pattern: new RegExp(
      '[\\w.-]{0,50}?(?:finnhub)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-z0-9]{20})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'gi',
    ),
  },
  {
    kind: 'gitleaks:flickr-access-token',
    pattern: new RegExp(
      '[\\w.-]{0,50}?(?:flickr)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-z0-9]{32})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'gi',
    ),
  },
  {
    kind: 'gitleaks:flutterwave-encryption-key',
    pattern: new RegExp('FLWSECK_TEST-[a-h0-9]{12}', 'gi'),
  },
  {
    kind: 'gitleaks:flutterwave-public-key',
    pattern: new RegExp('FLWPUBK_TEST-[a-h0-9]{32}-X', 'gi'),
  },
  {
    kind: 'gitleaks:flutterwave-secret-key',
    pattern: new RegExp('FLWSECK_TEST-[a-h0-9]{32}-X', 'gi'),
  },
  {
    kind: 'gitleaks:flyio-access-token',
    pattern: new RegExp(
      '\\b((?:fo1_[\\w-]{43}|fm1[ar]_[a-zA-Z0-9+\\/]{100,}={0,3}|fm2_[a-zA-Z0-9+\\/]{100,}={0,3}))(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'g',
    ),
  },
  { kind: 'gitleaks:frameio-api-token', pattern: new RegExp('fio-u-[a-z0-9\\-_=]{64}', 'gi') },
  {
    kind: 'gitleaks:freemius-secret-key',
    pattern: new RegExp('["\']secret_key["\']\\s*=>\\s*["\'](sk_[\\S]{29})["\']', 'gi'),
  },
  {
    kind: 'gitleaks:freshbooks-access-token',
    pattern: new RegExp(
      '[\\w.-]{0,50}?(?:freshbooks)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-z0-9]{64})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'gi',
    ),
  },
  {
    kind: 'gitleaks:gcp-api-key',
    pattern: new RegExp('\\b(AIza[\\w-]{35})(?:[\\x60\'"\\s;]|\\\\[nr]|$)', 'g'),
  },
  { kind: 'gitleaks:github-app-token', pattern: new RegExp('(?:ghu|ghs)_[0-9a-zA-Z]{36}', 'g') },
  { kind: 'gitleaks:github-fine-grained-pat', pattern: new RegExp('github_pat_\\w{82}', 'g') },
  { kind: 'gitleaks:github-oauth', pattern: new RegExp('gho_[0-9a-zA-Z]{36}', 'g') },
  { kind: 'gitleaks:github-pat', pattern: new RegExp('ghp_[0-9a-zA-Z]{36}', 'g') },
  { kind: 'gitleaks:github-refresh-token', pattern: new RegExp('ghr_[0-9a-zA-Z]{36}', 'g') },
  {
    kind: 'gitleaks:gitlab-cicd-job-token',
    pattern: new RegExp('glcbt-[0-9a-zA-Z]{1,5}_[0-9a-zA-Z_-]{20}', 'g'),
  },
  { kind: 'gitleaks:gitlab-deploy-token', pattern: new RegExp('gldt-[0-9a-zA-Z_\\-]{20}', 'g') },
  {
    kind: 'gitleaks:gitlab-feature-flag-client-token',
    pattern: new RegExp('glffct-[0-9a-zA-Z_\\-]{20}', 'g'),
  },
  { kind: 'gitleaks:gitlab-feed-token', pattern: new RegExp('glft-[0-9a-zA-Z_\\-]{20}', 'g') },
  {
    kind: 'gitleaks:gitlab-incoming-mail-token',
    pattern: new RegExp('glimt-[0-9a-zA-Z_\\-]{25}', 'g'),
  },
  {
    kind: 'gitleaks:gitlab-kubernetes-agent-token',
    pattern: new RegExp('glagent-[0-9a-zA-Z_\\-]{50}', 'g'),
  },
  {
    kind: 'gitleaks:gitlab-oauth-app-secret',
    pattern: new RegExp('gloas-[0-9a-zA-Z_\\-]{64}', 'g'),
  },
  { kind: 'gitleaks:gitlab-pat', pattern: new RegExp('glpat-[\\w-]{20}', 'g') },
  {
    kind: 'gitleaks:gitlab-pat-routable',
    pattern: new RegExp('\\bglpat-[0-9a-zA-Z_-]{27,300}\\.[0-9a-z]{2}[0-9a-z]{7}\\b', 'g'),
  },
  { kind: 'gitleaks:gitlab-ptt', pattern: new RegExp('glptt-[0-9a-f]{40}', 'g') },
  { kind: 'gitleaks:gitlab-rrt', pattern: new RegExp('GR1348941[\\w-]{20}', 'g') },
  {
    kind: 'gitleaks:gitlab-runner-authentication-token',
    pattern: new RegExp('glrt-[0-9a-zA-Z_\\-]{20}', 'g'),
  },
  {
    kind: 'gitleaks:gitlab-runner-authentication-token-routable',
    pattern: new RegExp('\\bglrt-t\\d_[0-9a-zA-Z_\\-]{27,300}\\.[0-9a-z]{2}[0-9a-z]{7}\\b', 'g'),
  },
  { kind: 'gitleaks:gitlab-scim-token', pattern: new RegExp('glsoat-[0-9a-zA-Z_\\-]{20}', 'g') },
  {
    kind: 'gitleaks:gitlab-session-cookie',
    pattern: new RegExp('_gitlab_session=[0-9a-z]{32}', 'g'),
  },
  {
    kind: 'gitleaks:gitter-access-token',
    pattern: new RegExp(
      '[\\w.-]{0,50}?(?:gitter)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-z0-9_-]{40})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'gi',
    ),
  },
  {
    kind: 'gitleaks:gocardless-api-token',
    pattern: new RegExp(
      '[\\w.-]{0,50}?(?:gocardless)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}(live_[a-z0-9\\-_=]{40})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'gi',
    ),
  },
  {
    kind: 'gitleaks:grafana-api-key',
    pattern: new RegExp(
      '\\b(eyJrIjoi[A-Za-z0-9]{70,400}={0,3})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'gi',
    ),
  },
  {
    kind: 'gitleaks:grafana-cloud-api-token',
    pattern: new RegExp('\\b(glc_[A-Za-z0-9+/]{32,400}={0,3})(?:[\\x60\'"\\s;]|\\\\[nr]|$)', 'gi'),
  },
  {
    kind: 'gitleaks:grafana-service-account-token',
    pattern: new RegExp(
      '\\b(glsa_[A-Za-z0-9]{32}_[A-Fa-f0-9]{8})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'gi',
    ),
  },
  {
    kind: 'gitleaks:harness-api-key',
    pattern: new RegExp('(?:pat|sat)\\.[a-zA-Z0-9_-]{22}\\.[a-zA-Z0-9]{24}\\.[a-zA-Z0-9]{20}', 'g'),
  },
  {
    kind: 'gitleaks:hashicorp-tf-api-token',
    pattern: new RegExp('[a-z0-9]{14}\\.(?:atlasv1)\\.[a-z0-9\\-_=]{60,70}', 'gi'),
  },
  {
    kind: 'gitleaks:hashicorp-tf-password',
    pattern: new RegExp(
      '[\\w.-]{0,50}?(?:administrator_login_password|password)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}("[a-z0-9=_\\-]{8,20}")(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'gi',
    ),
  },
  {
    kind: 'gitleaks:heroku-api-key',
    pattern: new RegExp(
      '[\\w.-]{0,50}?(?:heroku)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'gi',
    ),
  },
  {
    kind: 'gitleaks:heroku-api-key-v2',
    pattern: new RegExp('\\b((HRKU-AA[0-9a-zA-Z_-]{58}))(?:[\\x60\'"\\s;]|\\\\[nr]|$)', 'g'),
  },
  {
    kind: 'gitleaks:hubspot-api-key',
    pattern: new RegExp(
      '[\\w.-]{0,50}?(?:hubspot)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'gi',
    ),
  },
  {
    kind: 'gitleaks:huggingface-access-token',
    pattern: new RegExp('\\b(hf_(?:[a-z]{34}))(?:[\\x60\'"\\s;]|\\\\[nr]|$)', 'g'),
  },
  {
    kind: 'gitleaks:huggingface-organization-api-token',
    pattern: new RegExp('\\b(api_org_(?:[a-z]{34}))(?:[\\x60\'"\\s;]|\\\\[nr]|$)', 'g'),
  },
  {
    kind: 'gitleaks:infracost-api-token',
    pattern: new RegExp('\\b(ico-[a-zA-Z0-9]{32})(?:[\\x60\'"\\s;]|\\\\[nr]|$)', 'g'),
  },
  {
    kind: 'gitleaks:intercom-api-key',
    pattern: new RegExp(
      '[\\w.-]{0,50}?(?:intercom)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-z0-9=_\\-]{60})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'gi',
    ),
  },
  {
    kind: 'gitleaks:intra42-client-secret',
    pattern: new RegExp(
      '\\b(s-s4t2(?:ud|af)-[abcdef0123456789]{64})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'gi',
    ),
  },
  {
    kind: 'gitleaks:jfrog-api-key',
    pattern: new RegExp(
      '[\\w.-]{0,50}?(?:jfrog|artifactory|bintray|xray)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-z0-9]{73})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'gi',
    ),
  },
  {
    kind: 'gitleaks:jfrog-identity-token',
    pattern: new RegExp(
      '[\\w.-]{0,50}?(?:jfrog|artifactory|bintray|xray)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-z0-9]{64})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'gi',
    ),
  },
  {
    kind: 'gitleaks:jwt',
    pattern: new RegExp(
      '\\b(ey[a-zA-Z0-9]{17,}\\.ey[a-zA-Z0-9\\/\\\\_-]{17,}\\.(?:[a-zA-Z0-9\\/\\\\_-]{10,}={0,2})?)(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'g',
    ),
  },
  {
    kind: 'gitleaks:jwt-base64',
    pattern: new RegExp(
      '\\bZXlK(?:(?:aGJHY2lPaU)|(?:aGNIVWlPaU)|(?:aGNIWWlPaU)|(?:aGRXUWlPaU)|(?:aU5qUWlP)|(?:amNtbDBJanBi)|(?:amRIa2lPaU)|(?:bGNHc2lPbn)|(?:bGJtTWlPaU)|(?:cWEzVWlPaU)|(?:cWQyc2lPb)|(?:cGMzTWlPaU)|(?:cGRpSTZJ)|(?:cmFXUWlP)|(?:clpYbGZiM0J6SWpwY)|(?:cmRIa2lPaUp)|(?:dWIyNWpaU0k2)|(?:d01tTWlP)|(?:d01uTWlPaU)|(?:d2NIUWlPaU)|(?:emRXSWlPaU)|(?:emRuUWlP)|(?:MFlXY2lPaU)|(?:MGVYQWlPaUp)|(?:MWNtd2l)|(?:MWMyVWlPaUp)|(?:MlpYSWlPaU)|(?:MlpYSnphVzl1SWpv)|(?:NElqb2)|(?:NE5XTWlP)|(?:NE5YUWlPaU)|(?:NE5YUWpVekkxTmlJNkl)|(?:NE5YVWlPaU)|(?:NmFYQWlPaU))[a-zA-Z0-9\\/\\\\_+\\-\\r\\n]{40,}={0,2}',
      'g',
    ),
  },
  {
    kind: 'gitleaks:kraken-access-token',
    pattern: new RegExp(
      '[\\w.-]{0,50}?(?:kraken)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-z0-9\\/=_\\+\\-]{80,90})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'gi',
    ),
  },
  {
    kind: 'gitleaks:kubernetes-secret-yaml',
    pattern: new RegExp(
      '(?:\\bkind:[ \\t]*["\']?\\bsecret\\b["\']?(?:.){0,200}?\\bdata:(?:.){0,100}?\\s+([\\w.-]+:(?:[ \\t]*(?:\\||>[-+]?)\\s+)?[ \\t]*(?:["\']?[a-z0-9+/]{10,}={0,3}["\']?|\\{\\{[ \\t\\w"|$:=,.-]+}}|""|\'\'))|\\bdata:(?:.){0,100}?\\s+([\\w.-]+:(?:[ \\t]*(?:\\||>[-+]?)\\s+)?[ \\t]*(?:["\']?[a-z0-9+/]{10,}={0,3}["\']?|\\{\\{[ \\t\\w"|$:=,.-]+}}|""|\'\'))(?:.){0,200}?\\bkind:[ \\t]*["\']?\\bsecret\\b["\']?)',
      'gi',
    ),
  },
  {
    kind: 'gitleaks:kucoin-access-token',
    pattern: new RegExp(
      '[\\w.-]{0,50}?(?:kucoin)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-f0-9]{24})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'gi',
    ),
  },
  {
    kind: 'gitleaks:kucoin-secret-key',
    pattern: new RegExp(
      '[\\w.-]{0,50}?(?:kucoin)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'gi',
    ),
  },
  {
    kind: 'gitleaks:launchdarkly-access-token',
    pattern: new RegExp(
      '[\\w.-]{0,50}?(?:launchdarkly)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-z0-9=_\\-]{40})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'gi',
    ),
  },
  { kind: 'gitleaks:linear-api-key', pattern: new RegExp('lin_api_[a-z0-9]{40}', 'gi') },
  {
    kind: 'gitleaks:linear-client-secret',
    pattern: new RegExp(
      '[\\w.-]{0,50}?(?:linear)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-f0-9]{32})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'gi',
    ),
  },
  {
    kind: 'gitleaks:linkedin-client-id',
    pattern: new RegExp(
      '[\\w.-]{0,50}?(?:linked[_-]?in)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-z0-9]{14})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'gi',
    ),
  },
  {
    kind: 'gitleaks:linkedin-client-secret',
    pattern: new RegExp(
      '[\\w.-]{0,50}?(?:linked[_-]?in)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-z0-9]{16})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'gi',
    ),
  },
  {
    kind: 'gitleaks:lob-api-key',
    pattern: new RegExp(
      '[\\w.-]{0,50}?(?:lob)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}((live|test)_[a-f0-9]{35})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'gi',
    ),
  },
  {
    kind: 'gitleaks:lob-pub-api-key',
    pattern: new RegExp(
      '[\\w.-]{0,50}?(?:lob)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}((test|live)_pub_[a-f0-9]{31})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'gi',
    ),
  },
  {
    kind: 'gitleaks:looker-client-id',
    pattern: new RegExp(
      '[\\w.-]{0,50}?(?:looker)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-z0-9]{20})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'gi',
    ),
  },
  {
    kind: 'gitleaks:looker-client-secret',
    pattern: new RegExp(
      '[\\w.-]{0,50}?(?:looker)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-z0-9]{24})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'gi',
    ),
  },
  {
    kind: 'gitleaks:mailchimp-api-key',
    pattern: new RegExp(
      '[\\w.-]{0,50}?(?:MailchimpSDK.initialize|mailchimp)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-f0-9]{32}-us\\d\\d)(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'gi',
    ),
  },
  {
    kind: 'gitleaks:mailgun-private-api-token',
    pattern: new RegExp(
      '[\\w.-]{0,50}?(?:mailgun)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}(key-[a-f0-9]{32})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'gi',
    ),
  },
  {
    kind: 'gitleaks:mailgun-pub-key',
    pattern: new RegExp(
      '[\\w.-]{0,50}?(?:mailgun)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}(pubkey-[a-f0-9]{32})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'gi',
    ),
  },
  {
    kind: 'gitleaks:mailgun-signing-key',
    pattern: new RegExp(
      '[\\w.-]{0,50}?(?:mailgun)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-h0-9]{32}-[a-h0-9]{8}-[a-h0-9]{8})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'gi',
    ),
  },
  {
    kind: 'gitleaks:mapbox-api-token',
    pattern: new RegExp(
      '[\\w.-]{0,50}?(?:mapbox)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}(pk\\.[a-z0-9]{60}\\.[a-z0-9]{22})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'gi',
    ),
  },
  {
    kind: 'gitleaks:mattermost-access-token',
    pattern: new RegExp(
      '[\\w.-]{0,50}?(?:mattermost)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-z0-9]{26})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'gi',
    ),
  },
  {
    kind: 'gitleaks:maxmind-license-key',
    pattern: new RegExp(
      '\\b([A-Za-z0-9]{6}_[A-Za-z0-9]{29}_mmk)(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'g',
    ),
  },
  {
    kind: 'gitleaks:messagebird-api-token',
    pattern: new RegExp(
      '[\\w.-]{0,50}?(?:message[_-]?bird)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-z0-9]{25})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'gi',
    ),
  },
  {
    kind: 'gitleaks:messagebird-client-id',
    pattern: new RegExp(
      '[\\w.-]{0,50}?(?:message[_-]?bird)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'gi',
    ),
  },
  {
    kind: 'gitleaks:microsoft-teams-webhook',
    pattern: new RegExp(
      'https://[a-z0-9]+\\.webhook\\.office\\.com/webhookb2/[a-z0-9]{8}-([a-z0-9]{4}-){3}[a-z0-9]{12}@[a-z0-9]{8}-([a-z0-9]{4}-){3}[a-z0-9]{12}/IncomingWebhook/[a-z0-9]{32}/[a-z0-9]{8}-([a-z0-9]{4}-){3}[a-z0-9]{12}',
      'g',
    ),
  },
  {
    kind: 'gitleaks:netlify-access-token',
    pattern: new RegExp(
      '[\\w.-]{0,50}?(?:netlify)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-z0-9=_\\-]{40,46})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'gi',
    ),
  },
  {
    kind: 'gitleaks:new-relic-browser-api-token',
    pattern: new RegExp(
      '[\\w.-]{0,50}?(?:new-relic|newrelic|new_relic)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}(NRJS-[a-f0-9]{19})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'gi',
    ),
  },
  {
    kind: 'gitleaks:new-relic-insert-key',
    pattern: new RegExp(
      '[\\w.-]{0,50}?(?:new-relic|newrelic|new_relic)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}(NRII-[a-z0-9-]{32})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'gi',
    ),
  },
  {
    kind: 'gitleaks:new-relic-user-api-id',
    pattern: new RegExp(
      '[\\w.-]{0,50}?(?:new-relic|newrelic|new_relic)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-z0-9]{64})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'gi',
    ),
  },
  {
    kind: 'gitleaks:new-relic-user-api-key',
    pattern: new RegExp(
      '[\\w.-]{0,50}?(?:new-relic|newrelic|new_relic)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}(NRAK-[a-z0-9]{27})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'gi',
    ),
  },
  {
    kind: 'gitleaks:notion-api-token',
    pattern: new RegExp(
      '\\b(ntn_[0-9]{11}[A-Za-z0-9]{32}[A-Za-z0-9]{3})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'g',
    ),
  },
  {
    kind: 'gitleaks:npm-access-token',
    pattern: new RegExp('\\b(npm_[a-z0-9]{36})(?:[\\x60\'"\\s;]|\\\\[nr]|$)', 'gi'),
  },
  {
    kind: 'gitleaks:nuget-config-password',
    pattern: new RegExp(
      '<add key=\\"(?:(?:ClearText)?Password)\\"\\s*value=\\"(.{8,})\\"\\s*/>',
      'gi',
    ),
  },
  {
    kind: 'gitleaks:nytimes-access-token',
    pattern: new RegExp(
      '[\\w.-]{0,50}?(?:nytimes|new-york-times,|newyorktimes)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-z0-9=_\\-]{32})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'gi',
    ),
  },
  {
    kind: 'gitleaks:octopus-deploy-api-key',
    pattern: new RegExp('\\b(API-[A-Z0-9]{26})(?:[\\x60\'"\\s;]|\\\\[nr]|$)', 'g'),
  },
  {
    kind: 'gitleaks:okta-access-token',
    pattern: new RegExp(
      '[\\w.-]{0,50}?(?:[\\w.-]{0,50}?(?:(?:[Oo]kta|OKTA))(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3})(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}(00[\\w=\\-]{40})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'g',
    ),
  },
  {
    kind: 'gitleaks:openai-api-key',
    pattern: new RegExp(
      '\\b(sk-(?:proj|svcacct|admin)-(?:[A-Za-z0-9_-]{74}|[A-Za-z0-9_-]{58})T3BlbkFJ(?:[A-Za-z0-9_-]{74}|[A-Za-z0-9_-]{58})\\b|sk-[a-zA-Z0-9]{20}T3BlbkFJ[a-zA-Z0-9]{20})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'g',
    ),
  },
  {
    kind: 'gitleaks:openshift-user-token',
    pattern: new RegExp('\\b(sha256~[\\w-]{43})(?:[^\\w-]|\\z)', 'g'),
  },
  {
    kind: 'gitleaks:perplexity-api-key',
    pattern: new RegExp('\\b(pplx-[a-zA-Z0-9]{48})(?:[\\x60\'"\\s;]|\\\\[nr]|$|\\b)', 'g'),
  },
  {
    kind: 'gitleaks:plaid-api-token',
    pattern: new RegExp(
      '[\\w.-]{0,50}?(?:plaid)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}(access-(?:sandbox|development|production)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'gi',
    ),
  },
  {
    kind: 'gitleaks:plaid-client-id',
    pattern: new RegExp(
      '[\\w.-]{0,50}?(?:plaid)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-z0-9]{24})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'gi',
    ),
  },
  {
    kind: 'gitleaks:plaid-secret-key',
    pattern: new RegExp(
      '[\\w.-]{0,50}?(?:plaid)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-z0-9]{30})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'gi',
    ),
  },
  {
    kind: 'gitleaks:planetscale-api-token',
    pattern: new RegExp('\\b(pscale_tkn_[\\w=\\.-]{32,64})(?:[\\x60\'"\\s;]|\\\\[nr]|$)', 'gi'),
  },
  {
    kind: 'gitleaks:planetscale-oauth-token',
    pattern: new RegExp('\\b(pscale_oauth_[\\w=\\.-]{32,64})(?:[\\x60\'"\\s;]|\\\\[nr]|$)', 'g'),
  },
  {
    kind: 'gitleaks:planetscale-password',
    pattern: new RegExp('\\b(pscale_pw_[\\w=\\.-]{32,64})(?:[\\x60\'"\\s;]|\\\\[nr]|$)', 'gi'),
  },
  {
    kind: 'gitleaks:postman-api-token',
    pattern: new RegExp('\\b(PMAK-[a-f0-9]{24}\\-[a-f0-9]{34})(?:[\\x60\'"\\s;]|\\\\[nr]|$)', 'gi'),
  },
  {
    kind: 'gitleaks:prefect-api-token',
    pattern: new RegExp('\\b(pnu_[a-zA-Z0-9]{36})(?:[\\x60\'"\\s;]|\\\\[nr]|$)', 'g'),
  },
  {
    kind: 'gitleaks:private-key',
    pattern: new RegExp(
      '-----BEGIN[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----[\\s\\S-]{64,}?KEY(?: BLOCK)?-----',
      'gi',
    ),
  },
  {
    kind: 'gitleaks:privateai-api-token',
    pattern: new RegExp(
      '[\\w.-]{0,50}?(?:[\\w.-]{0,50}?(?:private[_-]?ai)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3})(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-z0-9]{32})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'g',
    ),
  },
  {
    kind: 'gitleaks:pulumi-api-token',
    pattern: new RegExp('\\b(pul-[a-f0-9]{40})(?:[\\x60\'"\\s;]|\\\\[nr]|$)', 'g'),
  },
  {
    kind: 'gitleaks:pypi-upload-token',
    pattern: new RegExp('pypi-AgEIcHlwaS5vcmc[\\w-]{50,1000}', 'g'),
  },
  {
    kind: 'gitleaks:rapidapi-access-token',
    pattern: new RegExp(
      '[\\w.-]{0,50}?(?:rapidapi)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-z0-9_-]{50})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'gi',
    ),
  },
  {
    kind: 'gitleaks:readme-api-token',
    pattern: new RegExp('\\b(rdme_[a-z0-9]{70})(?:[\\x60\'"\\s;]|\\\\[nr]|$)', 'g'),
  },
  {
    kind: 'gitleaks:rubygems-api-token',
    pattern: new RegExp('\\b(rubygems_[a-f0-9]{48})(?:[\\x60\'"\\s;]|\\\\[nr]|$)', 'g'),
  },
  {
    kind: 'gitleaks:scalingo-api-token',
    pattern: new RegExp('\\b(tk-us-[\\w-]{48})(?:[\\x60\'"\\s;]|\\\\[nr]|$)', 'g'),
  },
  {
    kind: 'gitleaks:sendbird-access-id',
    pattern: new RegExp(
      '[\\w.-]{0,50}?(?:sendbird)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'gi',
    ),
  },
  {
    kind: 'gitleaks:sendbird-access-token',
    pattern: new RegExp(
      '[\\w.-]{0,50}?(?:sendbird)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-f0-9]{40})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'gi',
    ),
  },
  {
    kind: 'gitleaks:sendgrid-api-token',
    pattern: new RegExp('\\b(SG\\.[a-z0-9=_\\-\\.]{66})(?:[\\x60\'"\\s;]|\\\\[nr]|$)', 'gi'),
  },
  {
    kind: 'gitleaks:sendinblue-api-token',
    pattern: new RegExp(
      '\\b(xkeysib-[a-f0-9]{64}\\-[a-z0-9]{16})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'gi',
    ),
  },
  {
    kind: 'gitleaks:sentry-access-token',
    pattern: new RegExp(
      '[\\w.-]{0,50}?(?:sentry)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-f0-9]{64})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'gi',
    ),
  },
  {
    kind: 'gitleaks:sentry-org-token',
    pattern: new RegExp(
      '\\bsntrys_eyJpYXQiO[a-zA-Z0-9+/]{10,200}(?:LCJyZWdpb25fdXJs|InJlZ2lvbl91cmwi|cmVnaW9uX3VybCI6)[a-zA-Z0-9+/]{10,200}={0,2}_[a-zA-Z0-9+/]{43}(?:[^a-zA-Z0-9+/]|\\z)',
      'g',
    ),
  },
  {
    kind: 'gitleaks:sentry-user-token',
    pattern: new RegExp('\\b(sntryu_[a-f0-9]{64})(?:[\\x60\'"\\s;]|\\\\[nr]|$)', 'g'),
  },
  {
    kind: 'gitleaks:settlemint-application-access-token',
    pattern: new RegExp('\\b(sm_aat_[a-zA-Z0-9]{16})(?:[\\x60\'"\\s;]|\\\\[nr]|$)', 'g'),
  },
  {
    kind: 'gitleaks:settlemint-personal-access-token',
    pattern: new RegExp('\\b(sm_pat_[a-zA-Z0-9]{16})(?:[\\x60\'"\\s;]|\\\\[nr]|$)', 'g'),
  },
  {
    kind: 'gitleaks:settlemint-service-access-token',
    pattern: new RegExp('\\b(sm_sat_[a-zA-Z0-9]{16})(?:[\\x60\'"\\s;]|\\\\[nr]|$)', 'g'),
  },
  {
    kind: 'gitleaks:shippo-api-token',
    pattern: new RegExp(
      '\\b(shippo_(?:live|test)_[a-fA-F0-9]{40})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'g',
    ),
  },
  { kind: 'gitleaks:shopify-access-token', pattern: new RegExp('shpat_[a-fA-F0-9]{32}', 'g') },
  {
    kind: 'gitleaks:shopify-custom-access-token',
    pattern: new RegExp('shpca_[a-fA-F0-9]{32}', 'g'),
  },
  {
    kind: 'gitleaks:shopify-private-app-access-token',
    pattern: new RegExp('shppa_[a-fA-F0-9]{32}', 'g'),
  },
  { kind: 'gitleaks:shopify-shared-secret', pattern: new RegExp('shpss_[a-fA-F0-9]{32}', 'g') },
  {
    kind: 'gitleaks:sidekiq-secret',
    pattern: new RegExp(
      '[\\w.-]{0,50}?(?:BUNDLE_ENTERPRISE__CONTRIBSYS__COM|BUNDLE_GEMS__CONTRIBSYS__COM)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-f0-9]{8}:[a-f0-9]{8})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'gi',
    ),
  },
  {
    kind: 'gitleaks:sidekiq-sensitive-url',
    pattern: new RegExp(
      '\\bhttps?://([a-f0-9]{8}:[a-f0-9]{8})@(?:gems.contribsys.com|enterprise.contribsys.com)(?:[\\/|\\#|\\?|:]|$)',
      'gi',
    ),
  },
  {
    kind: 'gitleaks:slack-app-token',
    pattern: new RegExp('xapp-\\d-[A-Z0-9]+-\\d+-[a-z0-9]+', 'gi'),
  },
  {
    kind: 'gitleaks:slack-bot-token',
    pattern: new RegExp('xoxb-[0-9]{10,13}-[0-9]{10,13}[a-zA-Z0-9-]*', 'g'),
  },
  {
    kind: 'gitleaks:slack-config-access-token',
    pattern: new RegExp('xoxe.xox[bp]-\\d-[A-Z0-9]{163,166}', 'gi'),
  },
  {
    kind: 'gitleaks:slack-config-refresh-token',
    pattern: new RegExp('xoxe-\\d-[A-Z0-9]{146}', 'gi'),
  },
  {
    kind: 'gitleaks:slack-legacy-bot-token',
    pattern: new RegExp('xoxb-[0-9]{8,14}-[a-zA-Z0-9]{18,26}', 'g'),
  },
  {
    kind: 'gitleaks:slack-legacy-token',
    pattern: new RegExp('xox[os]-\\d+-\\d+-\\d+-[a-fA-F\\d]+', 'g'),
  },
  {
    kind: 'gitleaks:slack-legacy-workspace-token',
    pattern: new RegExp('xox[ar]-(?:\\d-)?[0-9a-zA-Z]{8,48}', 'g'),
  },
  {
    kind: 'gitleaks:slack-user-token',
    pattern: new RegExp('xox[pe](?:-[0-9]{10,13}){3}-[a-zA-Z0-9-]{28,34}', 'g'),
  },
  {
    kind: 'gitleaks:slack-webhook-url',
    pattern: new RegExp(
      '(?:https?://)?hooks.slack.com/(?:services|workflows|triggers)/[A-Za-z0-9+/]{43,56}',
      'g',
    ),
  },
  {
    kind: 'gitleaks:snyk-api-token',
    pattern: new RegExp(
      '[\\w.-]{0,50}?(?:snyk[_.-]?(?:(?:api|oauth)[_.-]?)?(?:key|token))(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'gi',
    ),
  },
  {
    kind: 'gitleaks:sonar-api-token',
    pattern: new RegExp(
      '[\\w.-]{0,50}?(?:sonar[_.-]?(login|token))(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}((?:squ_|sqp_|sqa_)?[a-z0-9=_\\-]{40})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'gi',
    ),
  },
  {
    kind: 'gitleaks:square-access-token',
    pattern: new RegExp('\\b((?:EAAA|sq0atp-)[\\w-]{22,60})(?:[\\x60\'"\\s;]|\\\\[nr]|$)', 'g'),
  },
  {
    kind: 'gitleaks:squarespace-access-token',
    pattern: new RegExp(
      '[\\w.-]{0,50}?(?:squarespace)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'gi',
    ),
  },
  {
    kind: 'gitleaks:stripe-access-token',
    pattern: new RegExp(
      '\\b((?:sk|rk)_(?:test|live|prod)_[a-zA-Z0-9]{10,99})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'g',
    ),
  },
  {
    kind: 'gitleaks:sumologic-access-id',
    pattern: new RegExp(
      '[\\w.-]{0,50}?(?:[\\w.-]{0,50}?(?:(?:[Ss]umo|SUMO))(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3})(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}(su[a-zA-Z0-9]{12})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'g',
    ),
  },
  {
    kind: 'gitleaks:sumologic-access-token',
    pattern: new RegExp(
      '[\\w.-]{0,50}?(?:(?:[Ss]umo|SUMO))(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-z0-9]{64})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'gi',
    ),
  },
  {
    kind: 'gitleaks:telegram-bot-api-token',
    pattern: new RegExp(
      '[\\w.-]{0,50}?(?:telegr)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([0-9]{5,16}:(?:A)[a-z0-9_\\-]{34})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'gi',
    ),
  },
  {
    kind: 'gitleaks:travisci-access-token',
    pattern: new RegExp(
      '[\\w.-]{0,50}?(?:travis)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-z0-9]{22})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'gi',
    ),
  },
  { kind: 'gitleaks:twilio-api-key', pattern: new RegExp('SK[0-9a-fA-F]{32}', 'g') },
  {
    kind: 'gitleaks:twitch-api-token',
    pattern: new RegExp(
      '[\\w.-]{0,50}?(?:twitch)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-z0-9]{30})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'gi',
    ),
  },
  {
    kind: 'gitleaks:twitter-access-secret',
    pattern: new RegExp(
      '[\\w.-]{0,50}?(?:twitter)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-z0-9]{45})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'gi',
    ),
  },
  {
    kind: 'gitleaks:twitter-access-token',
    pattern: new RegExp(
      '[\\w.-]{0,50}?(?:twitter)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([0-9]{15,25}-[a-zA-Z0-9]{20,40})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'gi',
    ),
  },
  {
    kind: 'gitleaks:twitter-api-key',
    pattern: new RegExp(
      '[\\w.-]{0,50}?(?:twitter)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-z0-9]{25})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'gi',
    ),
  },
  {
    kind: 'gitleaks:twitter-api-secret',
    pattern: new RegExp(
      '[\\w.-]{0,50}?(?:twitter)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-z0-9]{50})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'gi',
    ),
  },
  {
    kind: 'gitleaks:twitter-bearer-token',
    pattern: new RegExp(
      '[\\w.-]{0,50}?(?:twitter)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}(A{22}[a-zA-Z0-9%]{80,100})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'gi',
    ),
  },
  {
    kind: 'gitleaks:typeform-api-token',
    pattern: new RegExp(
      '[\\w.-]{0,50}?(?:typeform)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}(tfp_[a-z0-9\\-_\\.=]{59})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'gi',
    ),
  },
  {
    kind: 'gitleaks:vault-batch-token',
    pattern: new RegExp('\\b(hvb\\.[\\w-]{138,300})(?:[\\x60\'"\\s;]|\\\\[nr]|$)', 'g'),
  },
  {
    kind: 'gitleaks:vault-service-token',
    pattern: new RegExp(
      '\\b((?:hvs\\.[\\w-]{90,120}|s\\.(?:[a-z0-9]{24})))(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'g',
    ),
  },
  {
    kind: 'gitleaks:yandex-access-token',
    pattern: new RegExp(
      '[\\w.-]{0,50}?(?:yandex)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}(t1\\.[A-Z0-9a-z_-]+[=]{0,2}\\.[A-Z0-9a-z_-]{86}[=]{0,2})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'gi',
    ),
  },
  {
    kind: 'gitleaks:yandex-api-key',
    pattern: new RegExp(
      '[\\w.-]{0,50}?(?:yandex)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}(AQVN[A-Za-z0-9_\\-]{35,38})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'gi',
    ),
  },
  {
    kind: 'gitleaks:yandex-aws-access-token',
    pattern: new RegExp(
      '[\\w.-]{0,50}?(?:yandex)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}(YC[a-zA-Z0-9_\\-]{38})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'gi',
    ),
  },
  {
    kind: 'gitleaks:zendesk-secret-key',
    pattern: new RegExp(
      '[\\w.-]{0,50}?(?:zendesk)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-z0-9]{40})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
      'gi',
    ),
  },
];
