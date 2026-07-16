export interface Device {
  label: string
  w: number | null // null = Fit (fill the stage)
  h: number | null
  dpr?: number
}

export interface DeviceGroup {
  group: string
  devices: Device[]
}

// A Chrome-device-mode-style catalog. Sizes are CSS (logical) pixels in
// portrait; the orientation toggle swaps w/h. dpr is informational.
export const DEVICE_GROUPS: DeviceGroup[] = [
  {
    group: 'General',
    devices: [
      { label: 'Fit', w: null, h: null },
      { label: 'Responsive', w: 1024, h: 768 },
    ],
  },
  {
    group: 'Phones',
    devices: [
      { label: 'iPhone SE', w: 375, h: 667, dpr: 2 },
      { label: 'iPhone 14', w: 390, h: 844, dpr: 3 },
      { label: 'iPhone 15 Pro Max', w: 430, h: 932, dpr: 3 },
      { label: 'Pixel 8', w: 412, h: 915, dpr: 2.6 },
      { label: 'Galaxy S24', w: 360, h: 780, dpr: 3 },
      { label: 'Galaxy S23 Ultra', w: 384, h: 824, dpr: 3.5 },
    ],
  },
  {
    group: 'Tablets',
    devices: [
      { label: 'iPad mini', w: 768, h: 1024, dpr: 2 },
      { label: 'iPad Air 11"', w: 834, h: 1194, dpr: 2 },
      { label: 'iPad Pro 12.9"', w: 1024, h: 1366, dpr: 2 },
      { label: 'Galaxy Tab S9', w: 800, h: 1280, dpr: 2.4 },
    ],
  },
  {
    group: 'Laptops',
    devices: [
      { label: 'MacBook Air 13"', w: 1280, h: 832, dpr: 2 },
      { label: 'MacBook Pro 14"', w: 1512, h: 982, dpr: 2 },
      { label: 'MacBook Pro 16"', w: 1728, h: 1117, dpr: 2 },
      { label: 'Laptop 1366', w: 1366, h: 768, dpr: 1 },
    ],
  },
  {
    group: 'Desktops',
    devices: [
      { label: 'Desktop 1080p', w: 1920, h: 1080, dpr: 1 },
      { label: 'QHD 1440p', w: 2560, h: 1440, dpr: 1 },
      { label: '4K UHD', w: 3840, h: 2160, dpr: 1 },
    ],
  },
  {
    group: 'Breakpoints',
    devices: [
      { label: 'BP 480', w: 480, h: 800 },
      { label: 'BP 600', w: 600, h: 800 },
      { label: 'BP 768', w: 768, h: 1024 },
      { label: 'BP 1024', w: 1024, h: 768 },
      { label: 'BP 1280', w: 1280, h: 800 },
    ],
  },
  {
    // NodeWatch's own responsive edges, from the merkle frontend's @media rules
    // (grep min-width/max-width in nodewatch/frontend/src): 480 is the phone
    // cutoff, 768 the dominant mobile↔desktop switch, 1024/1280 the wide steps.
    // Sizes sit just below/above each edge so you can see both sides of a rule.
    group: 'NodeWatch',
    devices: [
      { label: 'NW mobile', w: 375, h: 812 }, // ≤ 480 / ≤ 768 mobile layout
      { label: 'NW tablet', w: 768, h: 1024 }, // the 768 hinge
      { label: 'NW desktop', w: 1280, h: 832 }, // ≥ 1024 / ≥ 1280 wide layout
    ],
  },
]

export const ALL_DEVICES: Device[] = DEVICE_GROUPS.flatMap((g) => g.devices)
