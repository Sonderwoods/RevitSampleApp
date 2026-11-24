//! Platform shims: optional parallelism (rayon) and a wall clock that also works in WebAssembly.

#[cfg(feature = "parallel")]
pub use rayon::prelude::*;

/// Reduction with identity that works for rayon parallel iterators and plain iterators.
#[cfg(feature = "parallel")]
pub trait ReduceId: ParallelIterator {
    fn reduce_id<ID: Fn() -> Self::Item + Sync + Send, OP: Fn(Self::Item, Self::Item) -> Self::Item + Sync + Send>(self, id: ID, op: OP) -> Self::Item {
        self.reduce(id, op)
    }
}
#[cfg(feature = "parallel")]
impl<T: ParallelIterator> ReduceId for T {}

#[cfg(not(feature = "parallel"))]
mod seq {
    pub trait ParChunksMut<T> {
        fn par_chunks_mut(&mut self, n: usize) -> std::slice::ChunksMut<'_, T>;
    }
    impl<T> ParChunksMut<T> for [T] {
        fn par_chunks_mut(&mut self, n: usize) -> std::slice::ChunksMut<'_, T> {
            self.chunks_mut(n)
        }
    }
    pub trait IntoParIter: IntoIterator + Sized {
        fn into_par_iter(self) -> Self::IntoIter {
            self.into_iter()
        }
    }
    impl IntoParIter for std::ops::Range<usize> {}
    pub trait ReduceId: Iterator + Sized {
        fn reduce_id<ID: Fn() -> Self::Item, OP: Fn(Self::Item, Self::Item) -> Self::Item>(self, id: ID, op: OP) -> Self::Item {
            self.fold(id(), op)
        }
    }
    impl<T: Iterator> ReduceId for T {}
}
#[cfg(not(feature = "parallel"))]
pub use seq::*;

#[cfg(target_arch = "wasm32")]
#[link(wasm_import_module = "env")]
extern "C" {
    fn cb_host_now_ms() -> f64;
}

/// Monotonic stopwatch (std::time::Instant is unavailable on wasm32-unknown-unknown).
#[derive(Clone, Copy)]
pub struct Clock {
    #[cfg(not(target_arch = "wasm32"))]
    t: std::time::Instant,
    #[cfg(target_arch = "wasm32")]
    t: f64,
}

impl Clock {
    pub fn now() -> Clock {
        #[cfg(not(target_arch = "wasm32"))]
        return Clock { t: std::time::Instant::now() };
        #[cfg(target_arch = "wasm32")]
        return Clock { t: unsafe { cb_host_now_ms() } };
    }
    pub fn secs(&self) -> f64 {
        #[cfg(not(target_arch = "wasm32"))]
        return self.t.elapsed().as_secs_f64();
        #[cfg(target_arch = "wasm32")]
        return (unsafe { cb_host_now_ms() } - self.t) / 1000.0;
    }
    pub fn ms(&self) -> f64 {
        self.secs() * 1000.0
    }
}
