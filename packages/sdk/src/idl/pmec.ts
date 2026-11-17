/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/pmec.json`.
 */
export type Pmec = {
  "address": "13ZEq3jQvpn1r9KyaS9NK9HGoqZrHf6BJtwMyEbXbPtJ",
  "metadata": {
    "name": "pmec",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "PMEC Exchange: dynamic parimutuel prediction markets (C(q) = ||q||_2)"
  },
  "instructions": [
    {
      "name": "buy",
      "docs": [
        "Buys shares of one outcome from the pool."
      ],
      "discriminator": [
        102,
        6,
        61,
        18,
        1,
        218,
        235,
        234
      ],
      "accounts": [
        {
          "name": "buyer",
          "signer": true
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "market",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market.marketId",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "outcomeMint",
          "writable": true
        },
        {
          "name": "buyerUsdc",
          "docs": [
            "The buyer's USDC."
          ],
          "writable": true
        },
        {
          "name": "recipientShares",
          "docs": [
            "Where the new shares go. Any token account of the outcome mint, so a buyer",
            "can send shares straight to a fresh address."
          ],
          "writable": true
        },
        {
          "name": "potVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "treasuryVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  102,
                  101,
                  101,
                  115
                ]
              }
            ]
          }
        },
        {
          "name": "usdcMint",
          "relations": [
            "config"
          ]
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "outcome",
          "type": "u8"
        },
        {
          "name": "usdcIn",
          "type": "u64"
        },
        {
          "name": "minSharesOut",
          "type": "u64"
        }
      ]
    },
    {
      "name": "createMarket",
      "docs": [
        "Oracle: creates a market and its pot, seeded from the treasury."
      ],
      "discriminator": [
        103,
        226,
        97,
        235,
        200,
        188,
        251,
        254
      ],
      "accounts": [
        {
          "name": "oracle",
          "writable": true,
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "market",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "arg",
                "path": "marketId"
              }
            ]
          }
        },
        {
          "name": "potVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "treasuryVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  102,
                  101,
                  101,
                  115
                ]
              }
            ]
          }
        },
        {
          "name": "usdcMint",
          "relations": [
            "config"
          ]
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "marketId",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "kind",
          "type": {
            "defined": {
              "name": "marketKind"
            }
          }
        },
        {
          "name": "refs",
          "type": {
            "vec": "string"
          }
        },
        {
          "name": "n",
          "type": "u8"
        },
        {
          "name": "seedProbsPpm",
          "type": {
            "vec": "u32"
          }
        },
        {
          "name": "seedUsdc",
          "type": "u64"
        }
      ]
    },
    {
      "name": "halt",
      "docs": [
        "Oracle: mirrors a Gemini trading halt."
      ],
      "discriminator": [
        24,
        156,
        8,
        121,
        65,
        3,
        5,
        82
      ],
      "accounts": [
        {
          "name": "oracle",
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "market",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market.marketId",
                "account": "market"
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "initOutcomeMint",
      "docs": [
        "Oracle: creates outcome i's mint and mints its seed shares to the treasury."
      ],
      "discriminator": [
        151,
        123,
        164,
        232,
        195,
        38,
        104,
        132
      ],
      "accounts": [
        {
          "name": "oracle",
          "writable": true,
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "market",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market.marketId",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "outcomeMint",
          "docs": [
            "Outcome i's share mint: a classic SPL token whose only minter is the Market PDA."
          ],
          "writable": true
        },
        {
          "name": "seedShares",
          "docs": [
            "The treasury's seed shares of outcome i, owned by the Config PDA."
          ],
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "i",
          "type": "u8"
        }
      ]
    },
    {
      "name": "initialize",
      "docs": [
        "Creates Config and the treasury vault."
      ],
      "discriminator": [
        175,
        175,
        109,
        31,
        13,
        152,
        155,
        237
      ],
      "accounts": [
        {
          "name": "admin",
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "usdcMint"
        },
        {
          "name": "treasuryVault",
          "docs": [
            "Receives every fee and the seed shares' payouts, and pays every seed."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  102,
                  101,
                  101,
                  115
                ]
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "oracle",
          "type": "pubkey"
        },
        {
          "name": "poolFeeBps",
          "type": "u16"
        },
        {
          "name": "secondaryFeeBps",
          "type": "u16"
        }
      ]
    },
    {
      "name": "redeem",
      "docs": [
        "Burns shares for USDC after resolution or void."
      ],
      "discriminator": [
        184,
        12,
        86,
        149,
        70,
        196,
        97,
        225
      ],
      "accounts": [
        {
          "name": "holder",
          "signer": true
        },
        {
          "name": "market",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market.marketId",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "outcomeMint",
          "writable": true
        },
        {
          "name": "holderShares",
          "writable": true
        },
        {
          "name": "recipientUsdc",
          "docs": [
            "Where the USDC goes. Any USDC token account."
          ],
          "writable": true
        },
        {
          "name": "potVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "usdcMint"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "outcome",
          "type": "u8"
        },
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "redeemSeed",
      "docs": [
        "Anyone: redeems the treasury's seed shares of one outcome into the treasury vault."
      ],
      "discriminator": [
        57,
        22,
        70,
        172,
        77,
        115,
        231,
        83
      ],
      "accounts": [
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "market",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market.marketId",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "outcomeMint",
          "writable": true
        },
        {
          "name": "seedShares",
          "writable": true
        },
        {
          "name": "potVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "treasuryVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  102,
                  101,
                  101,
                  115
                ]
              }
            ]
          }
        },
        {
          "name": "usdcMint"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "outcome",
          "type": "u8"
        }
      ]
    },
    {
      "name": "resolve",
      "docs": [
        "Oracle: settles the market on Gemini's resolution."
      ],
      "discriminator": [
        246,
        150,
        236,
        206,
        108,
        63,
        58,
        10
      ],
      "accounts": [
        {
          "name": "oracle",
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "market",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market.marketId",
                "account": "market"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "winner",
          "type": "u8"
        }
      ]
    },
    {
      "name": "sweepDust",
      "docs": [
        "Admin: after all claims or 30 days, moves what is left in the pot to the treasury."
      ],
      "discriminator": [
        9,
        49,
        242,
        88,
        156,
        84,
        109,
        15
      ],
      "accounts": [
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "market",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market.marketId",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "potVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "treasuryVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  102,
                  101,
                  101,
                  115
                ]
              }
            ]
          }
        },
        {
          "name": "usdcMint"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": []
    },
    {
      "name": "unhalt",
      "docs": [
        "Oracle: lifts a halt."
      ],
      "discriminator": [
        249,
        140,
        27,
        213,
        128,
        130,
        207,
        113
      ],
      "accounts": [
        {
          "name": "oracle",
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "market",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market.marketId",
                "account": "market"
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "updateConfig",
      "docs": [
        "Admin: change the oracle or the fees."
      ],
      "discriminator": [
        29,
        158,
        252,
        191,
        10,
        83,
        219,
        99
      ],
      "accounts": [
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "oracle",
          "type": "pubkey"
        },
        {
          "name": "poolFeeBps",
          "type": "u16"
        },
        {
          "name": "secondaryFeeBps",
          "type": "u16"
        }
      ]
    },
    {
      "name": "void",
      "docs": [
        "Oracle: voids the market; every share redeems at its final pool price."
      ],
      "discriminator": [
        55,
        130,
        74,
        24,
        235,
        14,
        16,
        3
      ],
      "accounts": [
        {
          "name": "oracle",
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "market",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market.marketId",
                "account": "market"
              }
            ]
          }
        }
      ],
      "args": []
    }
  ],
  "accounts": [
    {
      "name": "config",
      "discriminator": [
        155,
        12,
        170,
        224,
        30,
        250,
        204,
        130
      ]
    },
    {
      "name": "market",
      "discriminator": [
        219,
        190,
        213,
        55,
        0,
        227,
        198,
        154
      ]
    }
  ],
  "events": [
    {
      "name": "buyEvent",
      "discriminator": [
        103,
        244,
        82,
        31,
        44,
        245,
        119,
        119
      ]
    },
    {
      "name": "haltEvent",
      "discriminator": [
        130,
        20,
        10,
        134,
        230,
        207,
        245,
        233
      ]
    },
    {
      "name": "marketCreated",
      "discriminator": [
        88,
        184,
        130,
        231,
        226,
        84,
        6,
        58
      ]
    },
    {
      "name": "redeemEvent",
      "discriminator": [
        90,
        114,
        83,
        146,
        212,
        26,
        217,
        59
      ]
    },
    {
      "name": "resolveEvent",
      "discriminator": [
        11,
        133,
        150,
        70,
        188,
        29,
        100,
        64
      ]
    },
    {
      "name": "voidEvent",
      "discriminator": [
        159,
        119,
        247,
        155,
        89,
        246,
        253,
        241
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "notOracle",
      "msg": "Only the oracle (relayer) can do this"
    },
    {
      "code": 6001,
      "name": "notAdmin",
      "msg": "Only the admin can do this"
    },
    {
      "code": 6002,
      "name": "badCollateralDecimals",
      "msg": "Collateral mint must have 6 decimals"
    },
    {
      "code": 6003,
      "name": "badFee",
      "msg": "Fee is above the 10% maximum"
    },
    {
      "code": 6004,
      "name": "badOutcomeCount",
      "msg": "Outcome count does not match the market kind (binary 2, multi 3-32, pair 4)"
    },
    {
      "code": 6005,
      "name": "badRefs",
      "msg": "Gemini refs do not match the market kind (pair needs 2, others 1; each 1-64 bytes)"
    },
    {
      "code": 6006,
      "name": "badProbabilities",
      "msg": "Seed probabilities must each be 0.5%-99.5% and sum to 100%"
    },
    {
      "code": 6007,
      "name": "seedTooSmall",
      "msg": "Seed is below the 1 USDC minimum"
    },
    {
      "code": 6008,
      "name": "treasuryCannotCoverSeed",
      "msg": "The treasury cannot cover this seed"
    },
    {
      "code": 6009,
      "name": "badOutcome",
      "msg": "Outcome index is out of range"
    },
    {
      "code": 6010,
      "name": "mintsNotReady",
      "msg": "Not every outcome mint has been created yet"
    },
    {
      "code": 6011,
      "name": "marketNotOpen",
      "msg": "Market is not open for buying"
    },
    {
      "code": 6012,
      "name": "marketClosed",
      "msg": "Market is already resolved or voided"
    },
    {
      "code": 6013,
      "name": "marketNotSettled",
      "msg": "Market is not resolved or voided yet"
    },
    {
      "code": 6014,
      "name": "marketNotHalted",
      "msg": "Market is not halted"
    },
    {
      "code": 6015,
      "name": "zeroAmount",
      "msg": "Amount is zero or too small to mint a share"
    },
    {
      "code": 6016,
      "name": "slippageExceeded",
      "msg": "Shares out is below min_shares_out"
    },
    {
      "code": 6017,
      "name": "potCapExceeded",
      "msg": "This buy would push the pot above its cap"
    },
    {
      "code": 6018,
      "name": "notWinningOutcome",
      "msg": "Only the winning outcome's shares can be redeemed"
    },
    {
      "code": 6019,
      "name": "sweepTooEarly",
      "msg": "Dust can be swept only after all claims or 30 days"
    },
    {
      "code": 6020,
      "name": "overflow",
      "msg": "Math overflow"
    },
    {
      "code": 6021,
      "name": "invariantPotBelowCost",
      "msg": "Invariant violated: pot must cover the cost function"
    },
    {
      "code": 6022,
      "name": "invariantVaultBelowPot",
      "msg": "Invariant violated: pot vault balance is below the recorded pot"
    },
    {
      "code": 6023,
      "name": "invariantSupplyMismatch",
      "msg": "Invariant violated: mint supply plus burned shares must equal q"
    },
    {
      "code": 6024,
      "name": "invariantPayoutAbovePot",
      "msg": "Invariant violated: payouts would exceed the pot"
    }
  ],
  "types": [
    {
      "name": "buyEvent",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "market",
            "type": "pubkey"
          },
          {
            "name": "buyer",
            "docs": [
              "Wallet that paid."
            ],
            "type": "pubkey"
          },
          {
            "name": "recipient",
            "docs": [
              "Wallet that owns the token account the shares went to (usually the buyer)."
            ],
            "type": "pubkey"
          },
          {
            "name": "outcome",
            "type": "u8"
          },
          {
            "name": "usdcIn",
            "docs": [
              "Gross USDC paid, fee included."
            ],
            "type": "u64"
          },
          {
            "name": "fee",
            "type": "u64"
          },
          {
            "name": "sharesOut",
            "type": "u64"
          },
          {
            "name": "priceAfter",
            "docs": [
              "Pool price of the outcome after the buy (1e6 = 1 USDC)."
            ],
            "type": "u64"
          },
          {
            "name": "probAfter",
            "docs": [
              "Implied probability after the buy, in ppm."
            ],
            "type": "u32"
          },
          {
            "name": "potAfter",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "config",
      "docs": [
        "Global settings and the treasury's running totals. PDA: [\"config\"]."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "admin",
            "type": "pubkey"
          },
          {
            "name": "oracle",
            "docs": [
              "The relayer key. Trusted: it creates markets and posts Gemini's resolutions."
            ],
            "type": "pubkey"
          },
          {
            "name": "usdcMint",
            "type": "pubkey"
          },
          {
            "name": "poolFeeBps",
            "type": "u16"
          },
          {
            "name": "secondaryFeeBps",
            "docs": [
              "Charged off-chain by the RFQ service inside each secondary settlement."
            ],
            "type": "u16"
          },
          {
            "name": "feesCollected",
            "docs": [
              "Pool fees received by the treasury vault."
            ],
            "type": "u64"
          },
          {
            "name": "seedsPaid",
            "docs": [
              "Seeds the treasury vault has paid into pots."
            ],
            "type": "u64"
          },
          {
            "name": "seedPayouts",
            "docs": [
              "Payouts the treasury has received for its seed shares."
            ],
            "type": "u64"
          },
          {
            "name": "dustSwept",
            "docs": [
              "Leftover pot dust swept to the treasury."
            ],
            "type": "u64"
          },
          {
            "name": "marketCount",
            "type": "u64"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "treasuryBump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "haltEvent",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "market",
            "type": "pubkey"
          },
          {
            "name": "halted",
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "market",
      "docs": [
        "One market = one pot. PDA: [\"market\", market_id]."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "marketId",
            "docs": [
              "Deterministic id: sha256 of the sorted Gemini refs (computed by the relayer)."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "kind",
            "type": {
              "defined": {
                "name": "marketKind"
              }
            }
          },
          {
            "name": "geminiRefs",
            "docs": [
              "Gemini tickers this market mirrors (1, or 2 for a pair pool)."
            ],
            "type": {
              "vec": "string"
            }
          },
          {
            "name": "nOutcomes",
            "type": "u8"
          },
          {
            "name": "q",
            "docs": [
              "Shares outstanding per outcome, seed included. Never decreases."
            ],
            "type": {
              "array": [
                "u128",
                32
              ]
            }
          },
          {
            "name": "pot",
            "docs": [
              "USDC the pot owes to holders (fees excluded). Goes down only on redeem and sweep."
            ],
            "type": "u64"
          },
          {
            "name": "status",
            "type": {
              "defined": {
                "name": "marketStatus"
              }
            }
          },
          {
            "name": "winner",
            "docs": [
              "Winning outcome index, or 255 before resolution."
            ],
            "type": "u8"
          },
          {
            "name": "payoutPerShare",
            "docs": [
              "USDC per winning share, scaled 1e12. Set by resolve."
            ],
            "type": "u128"
          },
          {
            "name": "finalPrices",
            "docs": [
              "Void price per share for each outcome, scaled 1e12. Set by void."
            ],
            "type": {
              "array": [
                "u64",
                32
              ]
            }
          },
          {
            "name": "createdAt",
            "type": "i64"
          },
          {
            "name": "resolvedAt",
            "docs": [
              "When the market was resolved or voided (0 before)."
            ],
            "type": "i64"
          },
          {
            "name": "seedUsdc",
            "type": "u64"
          },
          {
            "name": "burned",
            "docs": [
              "Shares burned by redemptions, per outcome. mint supply + burned = q."
            ],
            "type": {
              "array": [
                "u64",
                32
              ]
            }
          },
          {
            "name": "mintsReady",
            "docs": [
              "Bit i is set once outcome i's mint exists."
            ],
            "type": "u32"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "vaultBump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "marketCreated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "market",
            "type": "pubkey"
          },
          {
            "name": "marketId",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "kind",
            "type": {
              "defined": {
                "name": "marketKind"
              }
            }
          },
          {
            "name": "nOutcomes",
            "type": "u8"
          },
          {
            "name": "seedUsdc",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "marketKind",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "binary"
          },
          {
            "name": "multi"
          },
          {
            "name": "pair"
          }
        ]
      }
    },
    {
      "name": "marketStatus",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "open"
          },
          {
            "name": "halted"
          },
          {
            "name": "resolved"
          },
          {
            "name": "voided"
          }
        ]
      }
    },
    {
      "name": "redeemEvent",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "market",
            "type": "pubkey"
          },
          {
            "name": "holder",
            "type": "pubkey"
          },
          {
            "name": "outcome",
            "type": "u8"
          },
          {
            "name": "shares",
            "type": "u64"
          },
          {
            "name": "usdcOut",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "resolveEvent",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "market",
            "type": "pubkey"
          },
          {
            "name": "winner",
            "type": "u8"
          },
          {
            "name": "payoutPerShare",
            "docs": [
              "USDC per winning share, scaled 1e12."
            ],
            "type": "u128"
          },
          {
            "name": "pot",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "voidEvent",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "market",
            "type": "pubkey"
          },
          {
            "name": "pot",
            "type": "u64"
          }
        ]
      }
    }
  ],
  "constants": [
    {
      "name": "configSeed",
      "type": "bytes",
      "value": "[99, 111, 110, 102, 105, 103]"
    },
    {
      "name": "decimals",
      "docs": [
        "Outcome shares and USDC both use 6 decimals."
      ],
      "type": "u8",
      "value": "6"
    },
    {
      "name": "marketSeed",
      "type": "bytes",
      "value": "[109, 97, 114, 107, 101, 116]"
    },
    {
      "name": "maxRefLen",
      "docs": [
        "Longest Gemini ticker stored on a market."
      ],
      "type": "u32",
      "value": "64"
    },
    {
      "name": "mintSeed",
      "type": "bytes",
      "value": "[109, 105, 110, 116]"
    },
    {
      "name": "noWinner",
      "docs": [
        "`Market.winner` before resolution."
      ],
      "type": "u8",
      "value": "255"
    },
    {
      "name": "seedSharesSeed",
      "type": "bytes",
      "value": "[115, 101, 101, 100, 95, 115, 104, 97, 114, 101, 115]"
    },
    {
      "name": "sweepDelaySecs",
      "docs": [
        "Unclaimed pot funds can be swept to the treasury this long after resolution."
      ],
      "type": "i64",
      "value": "2592000"
    },
    {
      "name": "treasurySeed",
      "type": "bytes",
      "value": "[102, 101, 101, 115]"
    },
    {
      "name": "vaultSeed",
      "type": "bytes",
      "value": "[118, 97, 117, 108, 116]"
    }
  ]
};
