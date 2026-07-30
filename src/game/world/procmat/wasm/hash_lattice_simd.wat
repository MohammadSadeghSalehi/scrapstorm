;; WASM SIMD hash-lattice value noise (optimized)
;;
;; Optimizations:
;;  - fused 4-corner base: av(base), av(base+CA), av(base+CB), av(base+CA+CB)
;;  - avalanche fully inlined (no per-corner call)
;;  - seed*C hoisted once per fill
;;  - pointer-walking fills + align=16 loads/stores
;;  - fbm3: (4*n0+2*n1+n2)/7
;; Same hash constants as noise.ts hash2.

(module
  (memory (export "memory") 4)

  ;; avalanche only (used by hash4_ptr test path)
  (func $avalanche (param $n v128) (result v128)
    (local.set $n
      (i32x4.mul
        (v128.xor (local.get $n) (i32x4.shr_u (local.get $n) (i32.const 13)))
        (v128.const i32x4 1274126177 1274126177 1274126177 1274126177)))
    (local.set $n
      (v128.xor (local.get $n) (i32x4.shr_u (local.get $n) (i32.const 16))))
    (f32x4.mul
      (f32x4.convert_i32x4_u (local.get $n))
      (f32x4.splat (f32.const 0x1p-32)))
  )

  (func $hash_lattice (param $ix v128) (param $iy v128) (param $seed i32) (result v128)
    (call $avalanche
      (i32x4.add
        (i32x4.add
          (i32x4.mul (local.get $ix) (v128.const i32x4 374761393 374761393 374761393 374761393))
          (i32x4.mul (local.get $iy) (v128.const i32x4 668265263 668265263 668265263 668265263)))
        (i32x4.mul
          (i32x4.splat (local.get $seed))
          (v128.const i32x4 1442695041 1442695041 1442695041 1442695041))))
  )

  ;; Inlined value noise — avalanche expanded 4× (hottest path)
  (func $value_noise4_st
    (param $x v128) (param $y v128) (param $seed_term v128)
    (result v128)
    (local $x0f v128) (local $y0f v128)
    (local $ix v128) (local $iy v128)
    (local $fx v128) (local $fy v128) (local $t v128)
    (local $base v128) (local $n v128)
    (local $a v128) (local $b v128) (local $c v128) (local $d v128)
    (local $ab v128) (local $cd v128)
    (local $CA v128) (local $CB v128)
    (local $MIX v128) (local $INV v128)

    (local.set $CA (v128.const i32x4 374761393 374761393 374761393 374761393))
    (local.set $CB (v128.const i32x4 668265263 668265263 668265263 668265263))
    (local.set $MIX (v128.const i32x4 1274126177 1274126177 1274126177 1274126177))
    (local.set $INV (f32x4.splat (f32.const 0x1p-32)))

    (local.set $x0f (f32x4.floor (local.get $x)))
    (local.set $y0f (f32x4.floor (local.get $y)))
    (local.set $ix (i32x4.trunc_sat_f32x4_s (local.get $x0f)))
    (local.set $iy (i32x4.trunc_sat_f32x4_s (local.get $y0f)))

    (local.set $t (f32x4.sub (local.get $x) (local.get $x0f)))
    (local.set $fx
      (f32x4.mul
        (f32x4.mul (local.get $t) (local.get $t))
        (f32x4.sub (f32x4.splat (f32.const 3))
          (f32x4.mul (f32x4.splat (f32.const 2)) (local.get $t)))))
    (local.set $t (f32x4.sub (local.get $y) (local.get $y0f)))
    (local.set $fy
      (f32x4.mul
        (f32x4.mul (local.get $t) (local.get $t))
        (f32x4.sub (f32x4.splat (f32.const 3))
          (f32x4.mul (f32x4.splat (f32.const 2)) (local.get $t)))))

    (local.set $base
      (i32x4.add
        (i32x4.add
          (i32x4.mul (local.get $ix) (local.get $CA))
          (i32x4.mul (local.get $iy) (local.get $CB)))
        (local.get $seed_term)))

    ;; corner a = av(base)
    (local.set $n (local.get $base))
    (local.set $n
      (i32x4.mul
        (v128.xor (local.get $n) (i32x4.shr_u (local.get $n) (i32.const 13)))
        (local.get $MIX)))
    (local.set $a
      (f32x4.mul
        (f32x4.convert_i32x4_u
          (v128.xor (local.get $n) (i32x4.shr_u (local.get $n) (i32.const 16))))
        (local.get $INV)))

    ;; corner b = av(base+CA)
    (local.set $n (i32x4.add (local.get $base) (local.get $CA)))
    (local.set $n
      (i32x4.mul
        (v128.xor (local.get $n) (i32x4.shr_u (local.get $n) (i32.const 13)))
        (local.get $MIX)))
    (local.set $b
      (f32x4.mul
        (f32x4.convert_i32x4_u
          (v128.xor (local.get $n) (i32x4.shr_u (local.get $n) (i32.const 16))))
        (local.get $INV)))

    ;; corner c = av(base+CB)
    (local.set $n (i32x4.add (local.get $base) (local.get $CB)))
    (local.set $n
      (i32x4.mul
        (v128.xor (local.get $n) (i32x4.shr_u (local.get $n) (i32.const 13)))
        (local.get $MIX)))
    (local.set $c
      (f32x4.mul
        (f32x4.convert_i32x4_u
          (v128.xor (local.get $n) (i32x4.shr_u (local.get $n) (i32.const 16))))
        (local.get $INV)))

    ;; corner d = av(base+CA+CB)
    (local.set $n
      (i32x4.add (i32x4.add (local.get $base) (local.get $CA)) (local.get $CB)))
    (local.set $n
      (i32x4.mul
        (v128.xor (local.get $n) (i32x4.shr_u (local.get $n) (i32.const 13)))
        (local.get $MIX)))
    (local.set $d
      (f32x4.mul
        (f32x4.convert_i32x4_u
          (v128.xor (local.get $n) (i32x4.shr_u (local.get $n) (i32.const 16))))
        (local.get $INV)))

    (local.set $ab
      (f32x4.add (local.get $a)
        (f32x4.mul (f32x4.sub (local.get $b) (local.get $a)) (local.get $fx))))
    (local.set $cd
      (f32x4.add (local.get $c)
        (f32x4.mul (f32x4.sub (local.get $d) (local.get $c)) (local.get $fx))))
    (f32x4.add (local.get $ab)
      (f32x4.mul (f32x4.sub (local.get $cd) (local.get $ab)) (local.get $fy)))
  )

  (func $seed_term (param $seed i32) (result v128)
    (i32x4.mul
      (i32x4.splat (local.get $seed))
      (v128.const i32x4 1442695041 1442695041 1442695041 1442695041))
  )

  (func (export "fill_value_noise")
    (param $out i32) (param $xs i32) (param $ys i32) (param $count i32) (param $seed i32)
    (local $p_out i32) (local $p_xs i32) (local $p_ys i32) (local $end i32)
    (local $st v128) (local $x v128) (local $y v128)

    (local.set $st (call $seed_term (local.get $seed)))
    (local.set $p_out (local.get $out))
    (local.set $p_xs (local.get $xs))
    (local.set $p_ys (local.get $ys))
    (local.set $end (i32.add (local.get $xs) (i32.shl (local.get $count) (i32.const 2))))

    (block $done
      (br_if $done (i32.eqz (local.get $count)))
      (loop $L
        (local.set $x (v128.load align=16 (local.get $p_xs)))
        (local.set $y (v128.load align=16 (local.get $p_ys)))
        (v128.store align=16 (local.get $p_out)
          (call $value_noise4_st (local.get $x) (local.get $y) (local.get $st)))
        (local.set $p_xs (i32.add (local.get $p_xs) (i32.const 16)))
        (local.set $p_ys (i32.add (local.get $p_ys) (i32.const 16)))
        (local.set $p_out (i32.add (local.get $p_out) (i32.const 16)))
        (br_if $L (i32.lt_u (local.get $p_xs) (local.get $end)))
      )
    )
  )

  (func (export "fill_fbm3")
    (param $out i32) (param $xs i32) (param $ys i32) (param $count i32) (param $seed i32)
    (local $p_out i32) (local $p_xs i32) (local $p_ys i32) (local $end i32)
    (local $st0 v128) (local $st1 v128) (local $st2 v128)
    (local $x v128) (local $y v128)
    (local $n0 v128) (local $n1 v128) (local $n2 v128)
    (local $two v128) (local $four v128) (local $inv7 v128)

    (local.set $st0 (call $seed_term (local.get $seed)))
    (local.set $st1 (call $seed_term (i32.add (local.get $seed) (i32.const 1))))
    (local.set $st2 (call $seed_term (i32.add (local.get $seed) (i32.const 2))))
    (local.set $two (f32x4.splat (f32.const 2)))
    (local.set $four (f32x4.splat (f32.const 4)))
    (local.set $inv7 (f32x4.splat (f32.const 0.14285715)))

    (local.set $p_out (local.get $out))
    (local.set $p_xs (local.get $xs))
    (local.set $p_ys (local.get $ys))
    (local.set $end (i32.add (local.get $xs) (i32.shl (local.get $count) (i32.const 2))))

    (block $done
      (br_if $done (i32.eqz (local.get $count)))
      (loop $L
        (local.set $x (v128.load align=16 (local.get $p_xs)))
        (local.set $y (v128.load align=16 (local.get $p_ys)))
        (local.set $n0 (call $value_noise4_st (local.get $x) (local.get $y) (local.get $st0)))
        (local.set $n1
          (call $value_noise4_st
            (f32x4.mul (local.get $x) (local.get $two))
            (f32x4.mul (local.get $y) (local.get $two))
            (local.get $st1)))
        (local.set $n2
          (call $value_noise4_st
            (f32x4.mul (local.get $x) (local.get $four))
            (f32x4.mul (local.get $y) (local.get $four))
            (local.get $st2)))
        (v128.store align=16 (local.get $p_out)
          (f32x4.mul
            (f32x4.add
              (f32x4.add
                (f32x4.mul (local.get $n0) (local.get $four))
                (f32x4.mul (local.get $n1) (local.get $two)))
              (local.get $n2))
            (local.get $inv7)))
        (local.set $p_xs (i32.add (local.get $p_xs) (i32.const 16)))
        (local.set $p_ys (i32.add (local.get $p_ys) (i32.const 16)))
        (local.set $p_out (i32.add (local.get $p_out) (i32.const 16)))
        (br_if $L (i32.lt_u (local.get $p_xs) (local.get $end)))
      )
    )
  )

  (func (export "value_noise4_ptr")
    (param $out i32) (param $xp i32) (param $yp i32) (param $seed i32)
    (v128.store align=16 (local.get $out)
      (call $value_noise4_st
        (v128.load align=16 (local.get $xp))
        (v128.load align=16 (local.get $yp))
        (call $seed_term (local.get $seed))))
  )

  (func (export "hash4_ptr")
    (param $out i32) (param $ixp i32) (param $iyp i32) (param $seed i32)
    (v128.store align=16 (local.get $out)
      (call $hash_lattice
        (v128.load align=16 (local.get $ixp))
        (v128.load align=16 (local.get $iyp))
        (local.get $seed)))
  )
)
