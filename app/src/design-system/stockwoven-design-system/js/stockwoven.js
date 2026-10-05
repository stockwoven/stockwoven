/* @ds-bundle: {"format":4,"namespace":"Stockwoven","components":[{"name":"Logo"},{"name":"Button"},{"name":"PoweredBy"},{"name":"TickerChip"},{"name":"StatCard"},{"name":"WeavePattern"}]} */
(function(){
  var MARK_D="M6 37.98L21.64 53.62L6 69.25ZM30.75 94L46.38 78.36L62.02 94ZM21.01 6L6 21.01L6 9.71L9.71 6ZM30.12 46.38L46.38 30.12L69.88 53.62L53.62 69.88ZM78.99 94L94 78.99L94 90.29L90.29 94ZM69.25 6L53.62 21.64L37.98 6ZM78.36 46.38L94 30.75L94 62.02ZM6 29.49L29.49 6L45.76 22.26L22.26 45.76ZM6 77.74L29.49 54.24L45.76 70.51L22.26 94L9.71 94L6 90.29ZM54.24 29.49L77.74 6L90.29 6L94 9.71L94 22.26L70.51 45.76ZM54.24 77.74L77.74 54.24L94 70.51L70.51 94Z";
  function mark(fg){ return '<svg viewBox="0 0 100 100" width="100%" height="100%" aria-hidden="true"><path d="'+MARK_D+'" fill="'+(fg||'#101010')+'"/></svg>'; }
  // Woven halftone pattern: two sets of diagonal strands in a plain weave. Each strand is solid where it
  // rides on top of a crossing and breaks into halftone dots as it dives under the next strand, lit from one side.
  function weave(c){
    var r=c.getBoundingClientRect(); if(!r.width||!r.height) return;
    var d=Math.min(window.devicePixelRatio||1,2); c.width=Math.round(r.width*d); c.height=Math.round(r.height*d);
    var x=c.getContext('2d'); x.setTransform(d,0,0,d,0,0);
    var W=r.width,H=r.height,light=!!c.dataset.light,seed=+c.dataset.seed||0,fade=+c.dataset.fade||0;
    var INK='#101010',IV='#F4F0E5',PU='#9945FF';
    var ground=light?IV:INK, colA=light?INK:IV, colB=PU;
    var P=Math.max(110,Math.min(230,Math.max(W,H)/3.6));     // strand pitch
    var Wd=P*0.8;                                              // strand width (black gap = 20% of pitch)
    var cell=Math.max(4,P/17);                                 // halftone grid
    var S=Math.SQRT1_2, off=(seed*0.37)%1*P;
    x.fillStyle=ground; x.fillRect(0,0,W,H);
    var cols={}; cols[colA]=[]; cols[colB]=[];
    for(var cy=cell/2;cy<H+cell;cy+=cell){
      for(var cx=cell/2;cx<W+cell;cx+=cell){
        var u=(cx+cy)*S+off, v=(cy-cx)*S+2000+off*0.5;
        var ia=Math.floor(u/P), ib=Math.floor(v/P);
        var du=u-(ia+0.5)*P, dv=v-(ib+0.5)*P;
        var inA=Math.abs(du)<=Wd/2, inB=Math.abs(dv)<=Wd/2;
        if(!inA&&!inB) continue;
        var phA=Math.PI*(v/P-0.5)+Math.PI*ia, phB=Math.PI*(u/P-0.5)+Math.PI*ib+Math.PI;
        var hA=Math.cos(phA), hB=Math.cos(phB);
        var useA=(inA&&inB)?hA>=hB:inA;
        var h=useA?hA:hB, slope=-Math.sin(useA?phA:phB);
        // depth (on top = 1, diving under = 0) plus a raking light that keeps one side bright longer
        var b=0.4+0.42*h+0.3*slope;
        b=b<0?0:b>1?1:b;
        if(!useA) b=1;                                         // purple strands stay solid; the other set carries the gradient
        // gap where this strand passes under the other one
        var other=useA?dv:du, oTop=useA?(hB>hA):(hA>hB);
        if(oTop&&Math.abs(other)>Wd/2&&Math.abs(other)<Wd/2+cell*1.2) b=0;
        if(fade){ var fx=cx/(W*fade); b*= fx<1?fx*fx:1; }
        if(b<0.04) continue;
        (useA?cols[colA]:cols[colB]).push(cx,cy,b);
      }
    }
    [colA,colB].forEach(function(col){
      var a=cols[col]; x.fillStyle=col; x.beginPath();
      for(var k=0;k<a.length;k+=3){
        var bb=a[k+2];
        if(bb>0.97){ x.rect(a[k]-cell/2,a[k+1]-cell/2,cell+0.6,cell+0.6); continue; }
        var rr=cell*0.62*Math.sqrt(bb);
        x.moveTo(a[k]+rr,a[k+1]); x.arc(a[k],a[k+1],rr,0,6.2832);
      }
      x.fill();
    });
  }
  function weaveOpts(c,o){ o=o||{}; if(o.seed!=null) c.dataset.seed=o.seed; if(o.light) c.dataset.light='1'; if(o.fade) c.dataset.fade=o.fade; weave(c); }
  window.Stockwoven={ markPath: MARK_D, mark: mark, weave: weaveOpts,
    mountMarks: function(root){ (root||document).querySelectorAll('[data-sw-mark]').forEach(function(el){ el.innerHTML=mark(el.getAttribute('data-sw-mark')); }); },
    mountWeaves: function(root){ (root||document).querySelectorAll('canvas[data-sw-weave]').forEach(function(c){ weave(c); }); } };
})();
