from pathlib import Path

OUTPUT_DIR = Path(r"C:\_dev\_models\a_kakk\sites\kkpresent\mockups")
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

CANVAS = {"width": 1440, "height": 900}
NAV_LINKS = [
    "Overview",
    "Option Ideas",
    "Customer Links",
    "Highlight BN",
    "References",
]

pages = [
    {
        "filename": "page-home.svg",
        "title": "Home / Overview",
        "subtitle": "Website redesign narrative",
        "sections": [
            "Hero statement",
            "Purpose pillars",
            "Quick nav links",
            "Call to action",
        ],
    },
    {
        "filename": "page-option-ideas.svg",
        "title": "Option Ideas",
        "subtitle": "Option A (Hard) vs Option B (Simple)",
        "sections": [
            "Dual option comparison",
            "Wireframe sketch",
            "Highlight banner",
            "Competition insight",
        ],
    },
    {
        "filename": "page-customer-links.svg",
        "title": "Customer Links",
        "subtitle": "References & inspirational journeys",
        "sections": [
            "Persona highlights",
            "Overall link board",
            "Style & interface notes",
            "Playful exploration",
        ],
    },
    {
        "filename": "page-highlight-bn.svg",
        "title": "Highlight BN",
        "subtitle": "Video, Special points, CTA",
        "sections": [
            "Video hero",
            "Special point grid",
            "Reference links",
            "Other overall inspiration",
        ],
    },
    {
        "filename": "page-references.svg",
        "title": "References",
        "subtitle": "Story links & final race",
        "sections": [
            "Link list",
            "Infographic panel",
            "Story highlight",
            "Thank you footer",
        ],
    },
]


def render_nav(y: int) -> str:
    padding = 40
    gap = 20
    link_width = (CANVAS["width"] - padding * 2 - gap * (len(NAV_LINKS) - 1)) / len(NAV_LINKS)
    elements = [
        f'<rect x="{padding}" y="{y - 10}" width="{CANVAS["width"] - padding * 2}" height="50" rx="8" fill="#10131a" opacity="0.2" />'
    ]
    for idx, label in enumerate(NAV_LINKS):
        x = padding + idx * (link_width + gap)
        elements.append(
            f'<rect x="{x}" y="{y}" width="{link_width}" height="30" rx="6" fill="#0a84ff" opacity="0.15" stroke="#0a84ff" stroke-dasharray="6 6" />'
        )
        elements.append(
            f'<text x="{x + link_width / 2}" y="{y + 20}" text-anchor="middle" font-size="16" fill="#0a84ff" font-family="Inter, Arial, sans-serif">{label}</text>'
        )
    return "\n".join(elements)


def render_sections(items: list[str]) -> str:
    cols = 2
    rows = (len(items) + 1) // 2
    padding = 60
    card_width = (CANVAS["width"] - padding * 2 - 40) / cols
    card_height = 140
    elements = []
    for idx, text in enumerate(items):
        col = idx % cols
        row = idx // cols
        x = padding + col * (card_width + 40)
        y = 360 + row * (card_height + 30)
        elements.append(
            f'<rect x="{x}" y="{y}" width="{card_width}" height="{card_height}" rx="16" fill="#ffffff" opacity="0.9" stroke="#dde1ea" />'
        )
        elements.append(
            f'<text x="{x + 20}" y="{y + 40}" font-size="20" fill="#1b2a41" font-family="Inter, Arial, sans-serif">{text}</text>'
        )
        elements.append(
            f'<line x1="{x + 20}" y1="{y + 60}" x2="{x + card_width - 20}" y2="{y + 60}" stroke="#c3cad9" stroke-dasharray="4 4" />'
        )
        elements.append(
            f'<text x="{x + 20}" y="{y + 90}" font-size="14" fill="#6b7280" font-family="Inter, Arial, sans-serif">Linked module placeholder</text>'
        )
    return "\n".join(elements)


def build_page(page: dict) -> None:
    svg_content = f"""<svg xmlns='http://www.w3.org/2000/svg' width='{CANVAS['width']}' height='{CANVAS['height']}' viewBox='0 0 {CANVAS['width']} {CANVAS['height']}'>
  <defs>
    <linearGradient id='bg' x1='0%' y1='0%' x2='100%' y2='100%'>
      <stop offset='0%' stop-color='#050816'/>
      <stop offset='50%' stop-color='#0a1c2d'/>
      <stop offset='100%' stop-color='#1a2c3f'/>
    </linearGradient>
  </defs>
  <rect width='100%' height='100%' fill='url(#bg)' />
  <text x='80' y='140' font-size='48' fill='#ffffff' font-family='Inter, Arial, sans-serif'>{page['title']}</text>
  <text x='80' y='190' font-size='20' fill='#93c5fd' font-family='Inter, Arial, sans-serif'>{page['subtitle']}</text>
  <rect x='80' y='220' width='{CANVAS['width'] - 160}' height='100' rx='24' fill='#ffffff' opacity='0.08' stroke='#0ea5e9' stroke-dasharray='12 12'/>
  <text x='110' y='260' font-size='18' fill='#e0f2fe' font-family='Inter, Arial, sans-serif'>Hero copy / CTA placeholder</text>
  {render_nav(320)}
  {render_sections(page['sections'])}
  <text x='80' y='{CANVAS['height'] - 60}' font-size='16' fill='#cbd5f5' font-family='Inter, Arial, sans-serif'>Arrows indicate linked navigation between pages</text>
</svg>"""
    (OUTPUT_DIR / page["filename"]).write_text(svg_content, encoding="utf-8")


for page in pages:
    build_page(page)

print(f"Generated {len(pages)} mockup SVG files in {OUTPUT_DIR}")
