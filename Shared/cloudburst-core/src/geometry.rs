//! Host-neutral geometry in metres.

#[derive(Clone, Debug, Default)]
pub struct Mesh {
    /// Packed x,y,z.
    pub verts: Vec<f64>,
    /// Packed vertex index triplets.
    pub tris: Vec<u32>,
}

impl Mesh {
    pub fn new(verts: Vec<f64>, tris: Vec<u32>) -> Self {
        Mesh { verts, tris }
    }
    pub fn bounds(&self) -> Bounds {
        let mut b = Bounds::empty();
        for v in self.verts.chunks_exact(3) {
            b.include(v[0], v[1]);
        }
        b
    }
    /// Axis-aligned box (for tests / demo buildings).
    pub fn quad(x0: f64, y0: f64, x1: f64, y1: f64, z: f64) -> Self {
        Mesh::new(vec![x0, y0, z, x1, y0, z, x1, y1, z, x0, y1, z], vec![0, 1, 2, 0, 2, 3])
    }
    /// Regular height field mesh from a function (tests / demo).
    pub fn height_field(x0: f64, y0: f64, w: f64, h: f64, nx: usize, ny: usize, f: impl Fn(f64, f64) -> f64) -> Self {
        let mut verts = Vec::with_capacity((nx + 1) * (ny + 1) * 3);
        for j in 0..=ny {
            for i in 0..=nx {
                let x = x0 + w * i as f64 / nx as f64;
                let y = y0 + h * j as f64 / ny as f64;
                verts.extend_from_slice(&[x, y, f(x, y)]);
            }
        }
        let mut tris = Vec::with_capacity(nx * ny * 6);
        for j in 0..ny {
            for i in 0..nx {
                let a = (j * (nx + 1) + i) as u32;
                let b = a + 1;
                let c = a + (nx + 1) as u32 + 1;
                let d = a + (nx + 1) as u32;
                tris.extend_from_slice(&[a, b, c, a, c, d]);
            }
        }
        Mesh::new(verts, tris)
    }
}

#[derive(Clone, Debug, Default)]
pub struct Polygon {
    pub xs: Vec<f64>,
    pub ys: Vec<f64>,
}

impl Polygon {
    pub fn new(mut xs: Vec<f64>, mut ys: Vec<f64>) -> Self {
        let n = xs.len().min(ys.len());
        xs.truncate(n);
        ys.truncate(n);
        if n > 1 && (xs[0] - xs[n - 1]).abs() < 1e-9 && (ys[0] - ys[n - 1]).abs() < 1e-9 {
            xs.pop();
            ys.pop();
        }
        Polygon { xs, ys }
    }
    pub fn rect(x0: f64, y0: f64, x1: f64, y1: f64) -> Self {
        Polygon::new(vec![x0, x1, x1, x0], vec![y0, y0, y1, y1])
    }
    pub fn bounds(&self) -> Bounds {
        let mut b = Bounds::empty();
        for i in 0..self.xs.len() {
            b.include(self.xs[i], self.ys[i]);
        }
        b
    }
}

#[derive(Clone, Debug, Default)]
pub struct Polyline {
    pub xs: Vec<f64>,
    pub ys: Vec<f64>,
}

#[derive(Clone, Copy, Debug)]
pub struct Bounds {
    pub min_x: f64,
    pub min_y: f64,
    pub max_x: f64,
    pub max_y: f64,
}

impl Bounds {
    pub fn empty() -> Self {
        Bounds { min_x: f64::INFINITY, min_y: f64::INFINITY, max_x: f64::NEG_INFINITY, max_y: f64::NEG_INFINITY }
    }
    pub fn include(&mut self, x: f64, y: f64) {
        self.min_x = self.min_x.min(x);
        self.min_y = self.min_y.min(y);
        self.max_x = self.max_x.max(x);
        self.max_y = self.max_y.max(y);
    }
    pub fn union(&mut self, o: &Bounds) {
        if o.is_valid() {
            self.include(o.min_x, o.min_y);
            self.include(o.max_x, o.max_y);
        }
    }
    pub fn intersect(&self, o: &Bounds) -> Bounds {
        Bounds { min_x: self.min_x.max(o.min_x), min_y: self.min_y.max(o.min_y), max_x: self.max_x.min(o.max_x), max_y: self.max_y.min(o.max_y) }
    }
    pub fn is_valid(&self) -> bool {
        self.max_x > self.min_x && self.max_y > self.min_y
    }
    pub fn width(&self) -> f64 {
        self.max_x - self.min_x
    }
    pub fn height(&self) -> f64 {
        self.max_y - self.min_y
    }
}
