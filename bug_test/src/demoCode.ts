export const demoCode = `-- bug habitat / the quiet lines smell sweeter

d1 $ sound "bd*4 [~ sn] hh*8"
  # gain 0.82
  # room 0.18

d2 $ slow 2 $ sound "808:3 808:7 ~ 808:5"
  # speed 0.75
  # pan 0.26

-- it can digest comments without breaking the music
d3 $ jux rev $ sound "metal:2 [hh cp] metal:5"
  # gain 0.64
  # crush 3

d4 $ sound "toys:4 toys:7 ~ toys:9"
  # speed 1.5
  # room 0.45

-- stale code becomes food; recent sound events become heat
d5 $ every 3 (fast 2) $ sound "bd sn [~ cp] hh*4"
  # gain 0.72
  # pan 0.8

hush

-- click the creature to scare it
-- click its poop to restore the eaten code
`;
