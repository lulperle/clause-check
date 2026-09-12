"""The nine things a reviewer needs off a contract, and how each is asked for.

Nine fixed fields rather than "summarise the contract", because a summary cannot be
checked and a field can. Each one is a question with a right answer, an absent answer,
or a wrong answer -- and the point of this project is that those are three different
outcomes, not two.

The `trap` note on some fields is not decoration. It records the specific plausible
wrong passage the document contains for that field, which is what makes the field
worth measuring: a model that answers from the nearest number rather than the right
clause fails exactly there, and it fails confidently.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Field:
    key: str
    label: str
    question: str


FIELDS: tuple[Field, ...] = (
    Field(
        "parties",
        "契約当事者",
        "契約の当事者の正式名称を、甲・乙の区別とともに記載してください。",
    ),
    Field(
        "term",
        "契約期間",
        "本契約自体の有効期間を記載してください。個別契約や保証期間の期間ではありません。",
    ),
    Field(
        "auto_renewal",
        "自動更新",
        "自動更新の定めがあるか。ある場合は、更新を止めるための予告期間と更新後の期間を"
        "記載してください。",
    ),
    Field(
        "payment_due",
        "支払期日",
        "代金または委託料の支払期日を記載してください。検収期限や検査期間は支払期日では"
        "ありません。",
    ),
    Field(
        "termination_notice",
        "中途解約の予告期間",
        "契約期間中に一方的に解約するための予告期間を記載してください。相手方の違反を"
        "理由とする解除、および更新を拒絶するための申出期限は、これに含めません。",
    ),
    Field(
        "liability_cap",
        "損害賠償額の上限",
        "損害賠償責任の総額に上限を設ける定めを記載してください。遅延損害金の利率、"
        "SLA違反による利用料の減額、品質保証期間は上限ではありません。",
    ),
    Field(
        "subcontracting",
        "再委託・第三者委託",
        "業務または製造を第三者に委託することの可否と条件を記載してください。自社の"
        "役員・従業員への開示、および第三者への再販売の禁止は、これに含めません。",
    ),
    Field(
        "confidentiality_survival",
        "秘密保持義務の存続期間",
        "契約終了後に秘密保持義務が存続する期間を記載してください。",
    ),
    Field(
        "jurisdiction",
        "管轄裁判所",
        "第一審の専属的合意管轄裁判所を記載してください。文書が裁判所名を明示していない"
        "場合は、書かれているとおりに記載し、裁判所名を補わないでください。",
    ),
)

BY_KEY = {f.key: f for f in FIELDS}
